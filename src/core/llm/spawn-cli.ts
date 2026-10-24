import { spawn } from 'node:child_process';
import { LlmError } from './types.js';

/** The slice of ChildProcess that spawnCli uses (easy to fake in tests). */
export interface ChildLike {
  stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    on(ev: 'error', cb: (e: Error) => void): unknown;
  };
  stdout: { on(ev: 'data', cb: (chunk: Buffer | string) => void): unknown };
  stderr: { on(ev: 'data', cb: (chunk: Buffer | string) => void): unknown };
  on(ev: 'error', cb: (e: NodeJS.ErrnoException) => void): unknown;
  on(ev: 'close', cb: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildLike;

export const defaultSpawn: SpawnFn = (command, args, opts) =>
  spawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike;

export interface SpawnCliOptions {
  command: string;
  args: string[];
  input?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Max bytes kept per stream (default 16 MiB); excess is dropped. */
  maxBytes?: number;
  spawnFn?: SpawnFn;
}

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export function spawnCli(opts: SpawnCliOptions): Promise<SpawnCliResult> {
  const { command, args, input, cwd, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('aborted', `${command} aborted before start`));
      return;
    }
    let child: ChildLike;
    try {
      child = spawnFn(command, args, { cwd });
    } catch (err) {
      reject(mapSpawnError(command, err as NodeJS.ErrnoException));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new LlmError('aborted', `${command} aborted`)));
    };

    const append = (cur: string, chunk: Buffer | string) =>
      cur.length >= maxBytes ? cur : (cur + chunk.toString()).slice(0, maxBytes);
    child.stdout.on('data', (c) => (stdout = append(stdout, c)));
    child.stderr.on('data', (c) => (stderr = append(stderr, c)));
    child.stdin.on('error', () => {
      /* process may exit before reading stdin; surfaced via close/error */
    });
    child.on('error', (err) => finish(() => reject(mapSpawnError(command, err))));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })));

    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new LlmError('timeout', `${command} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
    }

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function mapSpawnError(command: string, err: NodeJS.ErrnoException): LlmError {
  if (err.code === 'ENOENT') {
    return new LlmError('not_installed', `\`${command}\` was not found on PATH`, { cause: err });
  }
  return new LlmError('http', `Failed to run ${command}: ${err.message}`, { cause: err });
}

const AUTH_RE =
  /not logged in|please (run )?.*login|\/login|unauthori[sz]ed|authenticat|invalid api key|api key|401|sign in/i;
export function looksLikeAuthError(text: string): boolean {
  return AUTH_RE.test(text);
}

export function hasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,<\\[|])${escaped}(?![\\w-])`, 'm').test(help);
}
