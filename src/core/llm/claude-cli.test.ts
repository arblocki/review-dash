import { describe, expect, it } from 'vitest';
import { ClaudeCliProvider } from './claude-cli.js';
import { fakeSpawn, type FakeProc } from './fake-spawn.testutil.js';
import { LlmError } from './types.js';

const FULL_HELP = `Options:
  --allowedTools, --allowed-tools <tools...>
  --append-system-prompt <prompt>
  --system-prompt <prompt>
  --json-schema <schema>
  --tools <tools...>`;
const OLD_HELP = `Options:
  --allowedTools <tools...>
  --append-system-prompt <prompt>`;

const envelope = (over: object = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'hello',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
    ...over,
  });

function setup(help: string, run: FakeProc | ((args: string[]) => FakeProc)) {
  const fake = fakeSpawn((call) => {
    if (call.args[0] === '--help') return { stdout: help };
    return typeof run === 'function' ? run(call.args) : run;
  });
  const provider = new ClaudeCliProvider({ model: 'sonnet', spawnFn: fake.spawnFn });
  return { provider, ...fake };
}

describe('ClaudeCliProvider', () => {
  it('builds args with all optional flags, no tools without cwd, and maps the envelope', async () => {
    const { provider, calls } = setup(FULL_HELP, { stdout: envelope() });
    const schema = { type: 'object' };
    const res = await provider.complete({ system: 'SYS', prompt: 'PROMPT', jsonSchema: schema });
    expect(res).toEqual({
      text: 'hello',
      usage: { inputTokens: 15, outputTokens: 7, costUsd: 0.0123 },
    });
    const run = calls[1]!;
    expect(run.command).toBe('claude');
    expect(run.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'sonnet',
      '--system-prompt',
      'SYS',
      '--json-schema',
      JSON.stringify(schema),
      '--tools',
      '',
    ]);
    expect(run.stdin).toBe('PROMPT');
  });

  it('uses read-only tools and cwd when a checkout is given, never write tools', async () => {
    const { provider, calls } = setup(FULL_HELP, { stdout: envelope() });
    await provider.complete({ system: 's', prompt: 'p', cwd: '/repo' });
    const run = calls[1]!;
    expect(run.cwd).toBe('/repo');
    expect(run.args).toContain('Read,Grep,Glob');
    expect(run.args.join(' ')).not.toMatch(/Bash|Edit|Write/);
  });

  it('falls back when flags are missing and runs --help only once', async () => {
    const { provider, calls } = setup(OLD_HELP, { stdout: envelope() });
    await provider.complete({ system: 's', prompt: 'p', jsonSchema: {} });
    await provider.complete({ system: 's', prompt: 'p' });
    expect(calls.filter((c) => c.args[0] === '--help')).toHaveLength(1);
    const args = calls[1]!.args;
    expect(args).toContain('--append-system-prompt');
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('--tools');
    expect(args.slice(-2)).toEqual(['--allowedTools', '']);
  });

  it('prefers structured_output when present', async () => {
    const { provider } = setup(FULL_HELP, { stdout: envelope({ structured_output: { a: 1 } }) });
    expect((await provider.complete({ system: '', prompt: 'p' })).text).toBe('{"a":1}');
  });

  it('maps ENOENT to not_installed', async () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const { provider } = setup(FULL_HELP, {});
    const p2 = new ClaudeCliProvider({
      model: 'm',
      spawnFn: fakeSpawn(() => ({ error: err })).spawnFn,
    });
    await expect(p2.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'not_installed',
    });
    expect(provider).toBeDefined();
  });

  it('maps error envelopes', async () => {
    const auth = setup(FULL_HELP, {
      stdout: envelope({ is_error: true, result: 'Invalid API key · Please run /login' }),
    });
    await expect(auth.provider.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'auth',
    });
    const other = setup(FULL_HELP, { stdout: envelope({ is_error: true, result: 'overloaded' }) });
    await expect(other.provider.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'http',
    });
    const junk = setup(FULL_HELP, { stdout: 'not json', code: 1 });
    await expect(junk.provider.complete({ system: '', prompt: 'p' })).rejects.toBeInstanceOf(
      LlmError,
    );
  });

  it('kills the process on abort and timeout', async () => {
    const ac = new AbortController();
    const a = setup(FULL_HELP, { hang: true });
    const pending = a.provider.complete({ system: '', prompt: 'p', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(a.killed).toContain('SIGTERM');

    const fake = fakeSpawn((c) =>
      c.args[0] === '--help' ? { stdout: FULL_HELP } : { hang: true },
    );
    const t = new ClaudeCliProvider({ model: 'm', spawnFn: fake.spawnFn, timeoutMs: 30 });
    await expect(t.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
