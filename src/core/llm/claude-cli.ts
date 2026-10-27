import { hasFlag, looksLikeAuthError, spawnCli, type SpawnFn } from './spawn-cli.js';
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from './types.js';

export interface ClaudeCliOptions {
  model: string;
  command?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

interface Caps {
  systemPrompt: '--system-prompt' | '--append-system-prompt' | null;
  jsonSchema: boolean;
  tools: boolean;
  strictMcpConfig: boolean;
  allowedTools: boolean;
}

const READ_TOOLS = 'Read,Grep,Glob';

export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli';
  private readonly command: string;
  private caps?: Promise<Caps>;

  constructor(private readonly opts: ClaudeCliOptions) {
    this.command = opts.command ?? 'claude';
  }

  private detect(): Promise<Caps> {
    this.caps ??= spawnCli({
      command: this.command,
      args: ['--help'],
      timeoutMs: 30_000,
      spawnFn: this.opts.spawnFn,
    }).then(({ stdout, stderr }) => {
      const help = `${stdout}\n${stderr}`;
      return {
        systemPrompt: hasFlag(help, '--system-prompt')
          ? '--system-prompt'
          : hasFlag(help, '--append-system-prompt')
            ? '--append-system-prompt'
            : null,
        jsonSchema: hasFlag(help, '--json-schema'),
        tools: hasFlag(help, '--tools'),
        strictMcpConfig: hasFlag(help, '--strict-mcp-config'),
        allowedTools: hasFlag(help, '--allowedTools') || hasFlag(help, '--allowed-tools'),
      };
    });
    // Don't cache failures (e.g. not installed yet).
    this.caps.catch(() => (this.caps = undefined));
    return this.caps;
  }

  /** Exposed for tests. */
  async buildArgs(req: LlmRequest): Promise<string[]> {
    const caps = await this.detect();
    // Fail closed: without these flags we cannot guarantee a read-only, MCP-free run.
    const missing = [
      !caps.tools && '--tools',
      !caps.strictMcpConfig && '--strict-mcp-config',
    ].filter(Boolean);
    if (missing.length) {
      throw new LlmError(
        'unsupported',
        `claude CLI does not support ${missing.join(' and ')}, which are required to run read-only; upgrade the claude CLI`,
      );
    }
    const args = ['-p', '--output-format', 'json', '--model', this.opts.model];
    if (caps.systemPrompt && req.system) args.push(caps.systemPrompt, req.system);
    if (req.jsonSchema && caps.jsonSchema)
      args.push('--json-schema', JSON.stringify(req.jsonSchema));
    // Ignore the user's MCP config; with no --mcp-config passed, no MCP servers load.
    args.push('--strict-mcp-config');
    // --tools restricts the available set; --allowedTools alone would only pre-approve.
    // Read-only tools only, and only when a checkout is provided. Never Bash/Edit/Write.
    if (req.cwd) {
      args.push('--tools', READ_TOOLS);
      // Pre-approval is still needed in -p mode so the read tools aren't denied.
      if (caps.allowedTools) args.push('--allowedTools', READ_TOOLS);
    } else {
      args.push('--tools', '');
    }
    return args;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const args = await this.buildArgs(req);
    const caps = await this.detect();
    // Without a system-prompt flag, fold it into the prompt.
    const input = caps.systemPrompt || !req.system ? req.prompt : `${req.system}\n\n${req.prompt}`;
    const { stdout, stderr, code } = await spawnCli({
      command: this.command,
      args,
      input,
      cwd: req.cwd,
      timeoutMs: this.opts.timeoutMs,
      signal: req.signal,
      spawnFn: this.opts.spawnFn,
    });
    return parseEnvelope(stdout, stderr, code);
  }
}

export function parseEnvelope(stdout: string, stderr: string, code: number | null): LlmResult {
  let env: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      env = parsed as Record<string, unknown>;
    }
  } catch {
    /* handled below */
  }
  if (!env) {
    const detail = (stderr || stdout).trim().slice(0, 500);
    if (looksLikeAuthError(detail))
      throw new LlmError('auth', `claude CLI not authenticated: ${detail}`);
    throw new LlmError(
      'bad_output',
      `claude CLI exited ${code} without a JSON envelope: ${detail}`,
    );
  }

  const resultText = typeof env.result === 'string' ? env.result : '';
  if (
    env.is_error === true ||
    (typeof env.subtype === 'string' && env.subtype.startsWith('error'))
  ) {
    const msg = resultText || String(env.subtype ?? 'unknown error');
    if (looksLikeAuthError(msg)) throw new LlmError('auth', `claude CLI auth error: ${msg}`);
    if (env.subtype === 'error_max_turns') throw new LlmError('bad_output', `claude CLI: ${msg}`);
    throw new LlmError('http', `claude CLI error: ${msg}`);
  }

  let text = resultText;
  if (env.structured_output !== undefined && env.structured_output !== null) {
    text = JSON.stringify(env.structured_output);
  } else if (typeof env.result !== 'string') {
    throw new LlmError('bad_output', 'claude CLI envelope has no result');
  }

  const usage: LlmUsage = {};
  const u = env.usage as Record<string, unknown> | undefined;
  if (u && typeof u === 'object') {
    const num = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    if (typeof u.input_tokens === 'number') {
      usage.inputTokens =
        num('input_tokens') + num('cache_creation_input_tokens') + num('cache_read_input_tokens');
    }
    if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
  }
  if (typeof env.total_cost_usd === 'number') usage.costUsd = env.total_cost_usd;
  return Object.keys(usage).length ? { text, usage } : { text };
}
