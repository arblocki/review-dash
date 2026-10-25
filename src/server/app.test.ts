import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeGitHub } from '../core/testing/fakes.testutil.js';
import { openStore } from '../core/store/index.js';
import { createApp } from './app.js';
import { TOKEN_HEADER } from './security.js';

const TOKEN = 'test-token';
const PORT = 4321;
const pr = { owner: 'octocat', repo: 'hello-world', number: 1 };
const deps = { github: fakeGitHub(), store: openStore(':memory:') };
const app = createApp({ token: TOKEN, pr, port: () => PORT, ...deps });

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(path, {
    headers: { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN, ...headers },
  });
}

describe('token check', () => {
  it('allows a valid token', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects a missing token', async () => {
    const res = await app.request('/api/health', { headers: { host: `127.0.0.1:${PORT}` } });
    expect(res.status).toBe(401);
  });

  it.each(['wrong', 'test-toke', 'test-token-x', ''])('rejects token %j', async (bad) => {
    const res = await get('/api/health', { [TOKEN_HEADER]: bad });
    expect(res.status).toBe(401);
  });

  it('returns 404 JSON for unknown API routes', async () => {
    expect((await get('/api/nope')).status).toBe(404);
  });
});

describe('host check', () => {
  it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`])('allows %s', async (host) => {
    expect((await get('/api/health', { host })).status).toBe(200);
  });

  it.each(['evil.example', `evil.example:${PORT}`, '127.0.0.1:9999', '127.0.0.1', 'localhost'])(
    'rejects %s',
    async (host) => {
      expect((await get('/api/health', { host })).status).toBe(403);
    },
  );
});

describe('origin check', () => {
  it('allows a matching origin', async () => {
    const res = await get('/api/health', { origin: `http://localhost:${PORT}` });
    expect(res.status).toBe(200);
  });

  it.each(['http://evil.example', `http://evil.example:${PORT}`, 'null', 'http://127.0.0.1:1'])(
    'rejects origin %s',
    async (origin) => {
      expect((await get('/api/health', { origin })).status).toBe(403);
    },
  );
});

describe('/api/session', () => {
  it('returns the PR being reviewed', async () => {
    const res = await get('/api/session');
    expect(await res.json()).toEqual({ pr, label: 'octocat/hello-world#1' });
  });
});

describe('static UI serving', () => {
  const html = (asset: string) => `<!doctype html><script src="/assets/${asset}"></script>`;
  const host = { host: `127.0.0.1:${PORT}` };

  it('serves 503 until the UI is built, without recreating the app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rd-web-'));
    const webDir = join(root, 'web');
    try {
      const a = createApp({ token: TOKEN, pr, port: () => PORT, webDir, ...deps });
      expect((await a.request('/', { headers: host })).status).toBe(503);
      expect(
        (await a.request('/api/health', { headers: { ...host, [TOKEN_HEADER]: TOKEN } })).status,
      ).toBe(200);

      mkdirSync(join(webDir, 'assets'), { recursive: true });
      writeFileSync(join(webDir, 'index.html'), html('a.js'));
      writeFileSync(join(webDir, 'assets', 'a.js'), 'console.log(1)');
      const res = await a.request('/', { headers: host });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('a.js');
      expect((await a.request('/assets/a.js', { headers: host })).status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('picks up a rebuilt index.html for / and SPA routes', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'rd-web-'));
    try {
      writeFileSync(join(webDir, 'index.html'), html('old.js'));
      const a = createApp({ token: TOKEN, pr, port: () => PORT, webDir, ...deps });
      expect(await (await a.request('/', { headers: host })).text()).toContain('old.js');

      writeFileSync(join(webDir, 'index.html'), html('new.js'));
      for (const path of ['/', '/some/spa/route']) {
        const res = await a.request(path, { headers: host });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('new.js');
      }
    } finally {
      rmSync(webDir, { recursive: true, force: true });
    }
  });
});
