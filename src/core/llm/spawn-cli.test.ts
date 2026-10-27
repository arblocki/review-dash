import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fakeSpawn } from './fake-spawn.testutil.js';
import { defaultSpawn, liveProcessGroups, spawnCli, type SpawnFn } from './spawn-cli.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('spawnCli termination', () => {
  it('escalates to SIGKILL after the grace period and rejects only after close', async () => {
    const { spawnFn, killed } = fakeSpawn(() => ({ hang: true, ignoreSigterm: true }));
    const started = Date.now();
    let settled = false;
    const p = spawnCli({
      command: 'x',
      args: [],
      timeoutMs: 20,
      killGraceMs: 80,
      spawnFn,
    }).catch((e: unknown) => {
      settled = true;
      throw e;
    });
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 60));
    expect(killed).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
    expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('rejects an abort after the child exits on SIGTERM, without SIGKILL', async () => {
    const { spawnFn, killed } = fakeSpawn(() => ({ hang: true }));
    const ac = new AbortController();
    const p = spawnCli({ command: 'x', args: [], signal: ac.signal, killGraceMs: 50, spawnFn });
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    await new Promise((r) => setTimeout(r, 80));
    expect(killed).toEqual(['SIGTERM']);
  });

  it.skipIf(process.platform === 'win32')(
    'really stops a process that ignores SIGTERM',
    async () => {
      let pid: number | undefined;
      const spawnFn: SpawnFn = (c, a, o) => {
        const child = defaultSpawn(c, a, o);
        pid = child.pid;
        return child;
      };
      await expect(
        spawnCli({
          command: process.execPath,
          args: ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
          timeoutMs: 300,
          killGraceMs: 200,
          spawnFn,
        }),
      ).rejects.toMatchObject({ kind: 'timeout' });
      expect(pid).toBeGreaterThan(0);
      expect(alive(pid!)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')('kills descendants via the process group', async () => {
    let pid: number | undefined;
    const spawnFn: SpawnFn = (c, a, o) => {
      const child = defaultSpawn(c, a, o);
      pid = child.pid;
      return child;
    };
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000)`;
    let out = '';
    let run!: Promise<unknown>;
    const grand = new Promise<number>((resolve) => {
      const wrapped: SpawnFn = (c, a, o) => {
        const child = spawnFn(c, a, o);
        child.stdout.on('data', (d) => {
          out += d.toString();
          if (out.includes('\n')) resolve(Number(out.trim()));
        });
        return child;
      };
      run = spawnCli({
        command: process.execPath,
        args: ['-e', script],
        timeoutMs: 600,
        killGraceMs: 200,
        spawnFn: wrapped,
      });
      run.catch(() => undefined);
    });
    const grandPid = await grand;
    await expect(run).rejects.toMatchObject({ kind: 'timeout' });
    expect(alive(pid!)).toBe(false);
    // The orphaned grandchild is reaped by init, which may lag slightly.
    await vi.waitFor(() => expect(alive(grandPid)).toBe(false), { timeout: 5000 });
  });

  it.skipIf(process.platform === 'win32')(
    'SIGKILLs a descendant that ignores SIGTERM even after the leader exits on SIGTERM',
    async () => {
      // The leader exits on SIGTERM (default handling); its child, in the same process group,
      // ignores SIGTERM. The call must not settle until that child is gone too.
      const stubborn = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
      const leader = `
        const { spawn } = require('node:child_process');
        const c = spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { stdio: 'ignore' });
        console.log(c.pid);
        setInterval(() => {}, 1000);
      `;
      let grandPid = 0;
      const spawnFn: SpawnFn = (cmd, a, o) => {
        const child = defaultSpawn(cmd, a, o);
        child.stdout.on('data', (d) => (grandPid ||= Number(String(d).trim())));
        return child;
      };
      const started = Date.now();
      const run = spawnCli({
        command: process.execPath,
        args: ['-e', leader],
        timeoutMs: 500,
        killGraceMs: 400,
        spawnFn,
      });
      await expect(run).rejects.toMatchObject({ kind: 'timeout' });
      expect(grandPid).toBeGreaterThan(0);
      // Settling waited for the SIGKILL escalation instead of returning when the leader died.
      expect(Date.now() - started).toBeGreaterThanOrEqual(500 + 400);
      await vi.waitFor(() => expect(alive(grandPid)).toBe(false), { timeout: 2000 });
      expect(liveProcessGroups().size).toBe(0);
    },
    10_000,
  );

  it('tracks running children and forgets them once they finish', async () => {
    const run = spawnCli({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 200)'] });
    await vi.waitFor(() => expect(liveProcessGroups().size).toBe(1));
    await run;
    expect(liveProcessGroups().size).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'kills still-running children when this process exits',
    async () => {
      // A separate Node process starts a long-running CLI child, prints its pid, then exits.
      const mod = fileURLToPath(new URL('./spawn-cli.ts', import.meta.url));
      const script = `
        import { spawnCli, liveProcessGroups } from ${JSON.stringify(mod)};
        spawnCli({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 60000 }).catch(() => {});
        setTimeout(() => { console.log([...liveProcessGroups()][0]); process.exit(0); }, 300);
      `;
      const out = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          encoding: 'utf8',
        },
      );
      const pid = Number(out.trim());
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
    },
    15_000,
  );

  it('spawns detached on POSIX only', async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({}));
    await spawnCli({ command: 'x', args: [], spawnFn });
    expect(calls[0]!.detached).toBe(process.platform !== 'win32');
  });
});
