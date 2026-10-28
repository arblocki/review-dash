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
const appTarget = { repo: { owner: pr.owner, repo: pr.repo }, initialPr: pr.number };
const deps = { github: fakeGitHub(), store: openStore(':memory:') };
const app = createApp({ token: TOKEN, ...appTarget, port: () => PORT, ...deps });

const auth = { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN };

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
  it('returns the repository and the PR to open first', async () => {
    const res = await get('/api/session');
    expect(await res.json()).toEqual({
      repo: appTarget.repo,
      pr,
      label: 'octocat/hello-world#1',
    });
  });

  it('has no PR when started with only a repository', async () => {
    const a = createApp({ token: TOKEN, repo: appTarget.repo, port: () => PORT, ...deps });
    expect(await (await a.request('/api/session', { headers: auth })).json()).toEqual({
      repo: appTarget.repo,
      pr: null,
      label: 'octocat/hello-world',
    });
  });

  it('has neither when started with no argument', async () => {
    const a = createApp({ token: TOKEN, port: () => PORT, ...deps });
    expect(await (await a.request('/api/session', { headers: auth })).json()).toEqual({
      repo: null,
      pr: null,
      label: 'review-dash',
    });
  });
});

describe('/api/repos', () => {
  it("lists the viewer's repositories", async () => {
    const summary = {
      owner: 'octocat',
      name: 'hello-world',
      description: 'My first repo',
      private: false,
      archived: false,
      fork: false,
      url: 'https://github.com/octocat/hello-world',
      pushedAt: '2026-01-02T00:00:00Z',
    };
    deps.github.repos = [summary];
    const res = await get('/api/repos');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [summary] });
  });

  it('lists open pull requests of any repository', async () => {
    const summary = {
      number: 7,
      title: 'Add retries',
      author: 'hubot',
      draft: false,
      url: 'https://github.com/other/thing/pull/7',
      headRef: 'retries',
      baseRef: 'main',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      labels: [],
      requestedReviewers: [],
    };
    const github = fakeGitHub();
    const asked: unknown[] = [];
    github.listOpenPrs = async (repo) => {
      asked.push(repo);
      return [summary];
    };
    const a = createApp({ token: TOKEN, port: () => PORT, github, store: deps.store });
    const res = await a.request('/api/repos/other/thing.js/pulls', { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pulls: [summary] });
    expect(asked).toEqual([{ owner: 'other', repo: 'thing.js' }]);
  });

  it('returns 502 with the upstream status when GitHub fails', async () => {
    const github = fakeGitHub();
    github.listOpenPrs = async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    };
    github.listRepos = async () => {
      throw Object.assign(new Error('Bad credentials'), { status: 401 });
    };
    const a = createApp({ token: TOKEN, port: () => PORT, github, store: deps.store });
    const pulls = await a.request('/api/repos/octocat/nope/pulls', { headers: auth });
    expect(pulls.status).toBe(502);
    expect(await pulls.json()).toEqual({ error: 'Not Found', upstreamStatus: 404 });
    const repos = await a.request('/api/repos', { headers: auth });
    expect(repos.status).toBe(502);
    expect(await repos.json()).toEqual({ error: 'Bad credentials', upstreamStatus: 401 });
  });

  it.each(['bad%20owner/r', 'o/r%3Fx', 'o/r%2Fx'])('rejects repository %j', async (r) => {
    expect((await get(`/api/repos/${r}/pulls`)).status).toBe(400);
    expect((await get(`/api/repos/${r}/pulls/1/pr`)).status).toBe(400);
  });

  it.each(['0', 'abc', '1e3', '-1', '99999999999999999999'])('rejects PR number %j', async (n) => {
    expect((await get(`/api/repos/octocat/hello-world/pulls/${n}/pr`)).status).toBe(400);
  });

  it('serves a PR of a repository other than the starting one', async () => {
    const res = await get('/api/repos/someone/else/pulls/5/pr');
    expect(res.status).toBe(200);
  });

  it('returns 404 JSON for unknown PR routes', async () => {
    const res = await get('/api/repos/octocat/hello-world/pulls/1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('requires the token on repository and PR routes', async () => {
    const host = { host: `127.0.0.1:${PORT}` };
    expect((await app.request('/api/repos', { headers: host })).status).toBe(401);
    const res = await app.request('/api/repos/octocat/hello-world/pulls/1/pr', { headers: host });
    expect(res.status).toBe(401);
  });
});

describe('static UI serving', () => {
  const html = (asset: string) => `<!doctype html><script src="/assets/${asset}"></script>`;
  const host = { host: `127.0.0.1:${PORT}` };

  it('serves 503 until the UI is built, without recreating the app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rd-web-'));
    const webDir = join(root, 'web');
    try {
      const a = createApp({ token: TOKEN, ...appTarget, port: () => PORT, webDir, ...deps });
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
      const a = createApp({ token: TOKEN, ...appTarget, port: () => PORT, webDir, ...deps });
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
