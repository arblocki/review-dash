import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexCliProvider } from './codex-cli.js';
import { fakeSpawn, type FakeProc, type SpawnCall } from './fake-spawn.testutil.js';

const FULL_HELP = `Options:
  --model <MODEL>
  --sandbox <MODE>
  --cd <DIR>
  --skip-git-repo-check
  --output-schema <FILE>
  --json
  --output-last-message <FILE>`;
const JSON_ONLY_HELP = `Options:
  --model <MODEL>
  --sandbox <MODE>
  --json`;

const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

function setup(help: string, run: (call: SpawnCall) => FakeProc) {
  const fake = fakeSpawn((call) => (call.args.includes('--help') ? { stdout: help } : run(call)));
  return {
    provider: new CodexCliProvider({ model: 'gpt-5-codex', spawnFn: fake.spawnFn }),
    ...fake,
  };
}

describe('CodexCliProvider', () => {
  it('passes schema file, reads last-message file, and cleans up temp files', async () => {
    let schemaFile = '';
    let schemaContent = '';
    const { provider, calls } = setup(FULL_HELP, (call) => ({
      async onRun() {
        schemaFile = arg(call.args, '--output-schema')!;
        schemaContent = await readFile(schemaFile, 'utf8');
        await writeFile(arg(call.args, '--output-last-message')!, '{"ok":true}\n');
      },
    }));
    const res = await provider.complete({
      system: 'SYS',
      prompt: 'PROMPT',
      jsonSchema: { type: 'object' },
      cwd: '/repo',
    });
    expect(res.text).toBe('{"ok":true}');
    const run = calls[1]!;
    expect(run.args.slice(0, 5)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5-codex',
    ]);
    expect(run.args).toContain('--skip-git-repo-check');
    expect(arg(run.args, '--cd')).toBe('/repo');
    expect(run.args.at(-1)).toBe('-');
    expect(run.args).not.toContain('--json');
    expect(run.stdin).toBe('SYS\n\nPROMPT');
    expect(schemaContent).toBe('{"type":"object"}');
    expect(existsSync(schemaFile)).toBe(false);
  });

  it('without a cwd runs in an empty temp dir', async () => {
    const { provider, calls } = setup(FULL_HELP, (call) => ({
      onRun: () => writeFile(arg(call.args, '--output-last-message')!, 'x'),
    }));
    await provider.complete({ system: '', prompt: 'p' });
    expect(calls[1]!.cwd).toMatch(/review-dash-codex-/);
    expect(calls[1]!.args).not.toContain('--cd');
  });

  it('falls back to the --json event stream and maps usage', async () => {
    const stdout = [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
      '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
    ].join('\n');
    const { provider, calls } = setup(JSON_ONLY_HELP, () => ({ stdout }));
    const res = await provider.complete({ system: '', prompt: 'p', jsonSchema: {} });
    expect(res).toEqual({ text: 'final', usage: { inputTokens: 3, outputTokens: 4 } });
    expect(calls[1]!.args).toContain('--json');
    expect(calls[1]!.args).not.toContain('--output-schema');
    expect(calls[1]!.args).not.toContain('--skip-git-repo-check');
  });

  it('maps errors', async () => {
    const err = Object.assign(new Error('x'), { code: 'ENOENT' });
    const missing = new CodexCliProvider({
      model: 'm',
      spawnFn: fakeSpawn(() => ({ error: err })).spawnFn,
    });
    await expect(missing.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'not_installed',
    });

    const auth = setup(FULL_HELP, () => ({ code: 1, stderr: 'Not logged in. Please sign in' }));
    await expect(auth.provider.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'auth',
    });

    const empty = setup(FULL_HELP, () => ({}));
    await expect(empty.provider.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'bad_output',
    });
  });
});
