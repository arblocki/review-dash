import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasFlag, looksLikeAuthError, spawnCli, type SpawnFn } from './spawn-cli.js';
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from './types.js';

export interface CodexCliOptions {
  model: string;
  command?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

interface Caps {
  outputSchema: boolean;
  outputLastMessage: boolean;
  json: boolean;
  skipGitRepoCheck: boolean;
  cd: boolean;
  sandbox: boolean;
}

export class CodexCliProvider implements LlmProvider {
  readonly id = 'codex-cli';
  private readonly command: string;
  private caps?: Promise<Caps>;

  constructor(private readonly opts: CodexCliOptions) {
    this.command = opts.command ?? 'codex';
  }

  private detect(): Promise<Caps> {
    this.caps ??= spawnCli({
      command: this.command,
      args: ['exec', '--help'],
      timeoutMs: 30_000,
      spawnFn: this.opts.spawnFn,
    }).then(({ stdout, stderr }) => {
      const help = `${stdout}\n${stderr}`;
      return {
        outputSchema: hasFlag(help, '--output-schema'),
        outputLastMessage: hasFlag(help, '--output-last-message'),
        json: hasFlag(help, '--json'),
        skipGitRepoCheck: hasFlag(help, '--skip-git-repo-check'),
        cd: hasFlag(help, '--cd'),
        sandbox: hasFlag(help, '--sandbox'),
      };
    });
    this.caps.catch(() => (this.caps = undefined));
    return this.caps;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const caps = await this.detect();
    const dir = await mkdtemp(join(tmpdir(), 'review-dash-codex-'));
    try {
      const args = ['exec', '--sandbox', 'read-only', '--model', this.opts.model];
      if (caps.skipGitRepoCheck) args.push('--skip-git-repo-check');
      if (req.cwd && caps.cd) args.push('--cd', req.cwd);
      if (req.jsonSchema && caps.outputSchema) {
        const schemaFile = join(dir, 'schema.json');
        await writeFile(schemaFile, JSON.stringify(req.jsonSchema));
        args.push('--output-schema', schemaFile);
      }
      const lastFile = join(dir, 'last-message.txt');
      const useLastFile = caps.outputLastMessage;
      if (useLastFile) args.push('--output-last-message', lastFile);
      else if (caps.json) args.push('--json');
      args.push('-'); // read the prompt from stdin

      // codex exec has no system-prompt flag: fold it into the prompt.
      const input = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;
      const { stdout, stderr, code } = await spawnCli({
        command: this.command,
        args,
        input,
        // Without a checkout, run in the empty temp dir so nothing is readable.
        // Set even when --cd is passed, in case the flag isn't supported.
        cwd: req.cwd ?? dir,
        timeoutMs: this.opts.timeoutMs,
        signal: req.signal,
        spawnFn: this.opts.spawnFn,
      });

      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(-500);
        if (looksLikeAuthError(detail))
          throw new LlmError('auth', `codex CLI not authenticated: ${detail}`);
        throw new LlmError('http', `codex exec exited ${code}: ${detail}`);
      }

      let text: string | undefined;
      if (useLastFile) {
        text = await readFile(lastFile, 'utf8').catch(() => undefined);
      } else if (caps.json) {
        text = lastAgentMessage(stdout);
      } else {
        text = stdout.trim();
      }
      if (!text?.trim()) throw new LlmError('bad_output', 'codex exec produced no final message');
      const usage = usageFromEvents(stdout);
      return usage ? { text: text.trim(), usage } : { text: text.trim() };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

interface CodexItem {
  type?: string;
  text?: unknown;
  message?: unknown;
}
interface CodexEvent {
  type?: string;
  item?: CodexItem;
  msg?: CodexItem;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function events(stdout: string): CodexEvent[] {
  const out: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t) as CodexEvent);
    } catch {
      /* skip non-JSON lines */
    }
  }
  return out;
}

/** Last agent message from a `codex exec --json` stream (new and legacy event shapes). */
export function lastAgentMessage(stdout: string): string | undefined {
  let last: string | undefined;
  for (const ev of events(stdout)) {
    const item = ev.item ?? ev.msg;
    if (item && (item.type === 'agent_message' || item.type === 'assistant_message')) {
      const t = item.text ?? item.message;
      if (typeof t === 'string') last = t;
    }
  }
  return last;
}

function usageFromEvents(stdout: string): LlmUsage | undefined {
  let usage: LlmUsage | undefined;
  for (const ev of events(stdout)) {
    const u = ev.usage;
    if (ev.type === 'turn.completed' && u && typeof u === 'object') {
      usage = {
        inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
        outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
      };
    }
  }
  return usage;
}
