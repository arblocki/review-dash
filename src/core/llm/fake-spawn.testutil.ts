import { EventEmitter } from 'node:events';
import type { ChildLike, SpawnFn } from './spawn-cli.js';

export interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
  stdin: string;
  detached?: boolean;
}

export interface FakeProc {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Emit this error (e.g. ENOENT) instead of running. */
  error?: NodeJS.ErrnoException;
  /** Never exit (for timeout/abort tests). */
  hang?: boolean;
  /** With `hang`: ignore SIGTERM (only SIGKILL ends the process). */
  ignoreSigterm?: boolean;
  /** Called when the process "runs"; may write files named in args. */
  onRun?: (call: SpawnCall) => void | Promise<void>;
}

/** Fake spawn: `handler` picks the behavior for each call. */
export function fakeSpawn(handler: (call: SpawnCall) => FakeProc) {
  const calls: SpawnCall[] = [];
  const killed: string[] = [];
  const spawnFn: SpawnFn = (command, args, opts) => {
    const call: SpawnCall = { command, args, cwd: opts.cwd, stdin: '', detached: opts.detached };
    let spec: FakeProc = {};
    let exited = false;
    calls.push(call);
    const ee = new EventEmitter();
    const out = new EventEmitter();
    const err = new EventEmitter();
    const child = Object.assign(ee, {
      stdin: {
        write: (c: string) => void (call.stdin += c),
        end: () => {
          spec = handler(call);
          setImmediate(async () => {
            if (spec.hang) return;
            if (spec.error) return void ee.emit('error', spec.error);
            await spec.onRun?.(call);
            if (spec.stdout) out.emit('data', Buffer.from(spec.stdout));
            if (spec.stderr) err.emit('data', Buffer.from(spec.stderr));
            ee.emit('close', spec.code ?? 0, null);
          });
        },
        on: () => undefined,
      },
      stdout: out,
      stderr: err,
      kill: (sig: string = 'SIGTERM') => {
        killed.push(sig);
        if (exited || (sig === 'SIGTERM' && spec.ignoreSigterm)) return;
        exited = true;
        setImmediate(() => {
          ee.emit('exit', null, sig);
          ee.emit('close', null, sig);
        });
      },
    }) as unknown as ChildLike;
    return child;
  };
  return { spawnFn, calls, killed };
}
