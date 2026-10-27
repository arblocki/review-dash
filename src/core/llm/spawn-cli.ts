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
  on(ev: 'close' | 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  pid?: number;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean },
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
  /** After SIGTERM on timeout/abort, wait this long before SIGKILL (default 2000ms). */
  killGraceMs?: number;
  spawnFn?: SpawnFn;
}

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 2000;
/** How long to wait for the child to be reaped after SIGKILL before giving up. */
const POST_KILL_WAIT_MS = 1000;
const POSIX = process.platform !== 'win32';

/**
 * Process groups of children still running. Detached children don't get the terminal's
 * SIGINT when review-dash is stopped, so kill them when this process exits.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const g of liveGroups) {
      try {
        process.kill(-g, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
}

/** Exposed for tests. */
export function liveProcessGroups(): ReadonlySet<number> {
  return liveGroups;
}

export function spawnCli(opts: SpawnCliOptions): Promise<SpawnCliResult> {
  const { command, args, input, cwd, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('aborted', `${command} aborted before start`));
      return;
    }
    let child: ChildLike;
    try {
      // On POSIX the child leads its own process group so we can signal descendants too.
      child = spawnFn(command, args, { cwd, detached: POSIX });
    } catch (err) {
      reject(mapSpawnError(command, err as NodeJS.ErrnoException));
      return;
    }
    const group = POSIX ? child.pid : undefined;
    if (group) trackGroup(group);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let stopping: LlmError | undefined;
    let leaderExited = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (group) liveGroups.delete(group);
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (POSIX && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    /** Whether any process in the child's group is still running (POSIX only). */
    const groupAlive = () => {
      if (!group) return false;
      try {
        process.kill(-group, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Once stopping, the leader exiting is not enough: a descendant may ignore SIGTERM.
    // Settle only when the whole group is gone; otherwise the SIGKILL escalation stays armed.
    const settleIfStopped = () => {
      if (stopping && leaderExited && !groupAlive()) finish(() => reject(stopping));
    };
    // SIGTERM, then SIGKILL after the grace period; reject only once the group is gone.
    const stop = (err: LlmError) => {
      if (settled || stopping) return;
      stopping = err;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      killTree('SIGTERM');
      graceTimer = setTimeout(() => {
        killTree('SIGKILL');
        poll = setInterval(settleIfStopped, 25);
        hardTimer = setTimeout(() => finish(() => reject(err)), POST_KILL_WAIT_MS);
      }, killGraceMs);
    };
    const onAbort = () => stop(new LlmError('aborted', `${command} aborted`));

    const append = (cur: string, chunk: Buffer | string) =>
      cur.length >= maxBytes ? cur : (cur + chunk.toString()).slice(0, maxBytes);
    child.stdout.on('data', (c) => (stdout = append(stdout, c)));
    child.stderr.on('data', (c) => (stderr = append(stderr, c)));
    child.stdin.on('error', () => {
      /* process may exit before reading stdin; surfaced via close/error */
    });
    child.on('error', (err) => finish(() => reject(stopping ?? mapSpawnError(command, err))));
    child.on('exit', () => {
      leaderExited = true;
      settleIfStopped();
    });
    child.on('close', (code) => {
      leaderExited = true;
      if (stopping) settleIfStopped();
      else finish(() => resolve({ stdout, stderr, code }));
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(
        () => stop(new LlmError('timeout', `${command} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
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
