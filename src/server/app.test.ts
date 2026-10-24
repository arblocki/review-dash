import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { TOKEN_HEADER } from './security.js';

const TOKEN = 'test-token';
const PORT = 4321;
const pr = { owner: 'octocat', repo: 'hello-world', number: 1 };
const app = createApp({ token: TOKEN, pr, port: () => PORT });

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
