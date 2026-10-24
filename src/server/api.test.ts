import { describe, expect, it } from 'vitest';
import { fakeGitHub, loadFixture } from '../core/testing/fakes.testutil.js';
import { openStore } from '../core/store/index.js';
import { createApp } from './app.js';
import { TOKEN_HEADER } from './security.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PORT = 4321;
const pr = { owner: 'octocat', repo: 'hello-world', number: 1 };
const HEAD = loadFixture().pr.headSha;

function setup(fixture: Parameters<typeof fakeGitHub>[0] = {}) {
  const github = fakeGitHub(fixture);
  const store = openStore(':memory:');
  const app = createApp({ token: 't', pr, port: () => PORT, github, store });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Omit<Response, 'json'> & { json(): Promise<Json> }> =>
    app.request(path, {
      method,
      headers: {
        host: `127.0.0.1:${PORT}`,
        [TOKEN_HEADER]: 't',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { github, store, call };
}

const draft = { path: 'src/greet.ts', side: 'RIGHT', line: 2, body: 'nit', headSha: HEAD };

describe('GET /api/pr', () => {
  it('returns metadata, parsed files, hash and viewer', async () => {
    const { call } = setup();
    const res = await call('GET', '/api/pr');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pr.headSha).toBe(HEAD);
    expect(json.viewer).toBe('reviewer');
    expect(json.isSelfReview).toBe(false);
    expect(json.diffHash).toMatch(/^[0-9a-f]{40}$/);
    expect(json.files.map((f: { path: string }) => f.path)).toEqual([
      'src/greet.ts',
      'src/hello.ts',
      'assets/logo.png',
      'package-lock.json',
    ]);
    expect(json.files[0].hunks).toHaveLength(2);
    expect(json.files[0].hunks[0].id).toMatch(/^[0-9a-f]{40}$/);
    expect(json.files[1]).toMatchObject({ oldPath: 'src/greeting.ts', status: 'renamed' });
    expect(json.files[2].binary).toBe(true);
    expect(json.files[3].patchMissing).toBe(true);
  });

  it('caches per run and refetches on ?refresh=1', async () => {
    const { call, github } = setup();
    await call('GET', '/api/pr');
    await call('GET', '/api/pr');
    expect(github.calls.fetchPr).toBe(1);
    await call('GET', '/api/pr?refresh=1');
    expect(github.calls.fetchPr).toBe(2);
  });

  it('requires the token', async () => {
    const { call } = setup();
    const app = createApp({
      token: 't',
      pr,
      port: () => PORT,
      github: fakeGitHub(),
      store: openStore(':memory:'),
    });
    expect((await app.request('/api/pr', { headers: { host: `127.0.0.1:${PORT}` } })).status).toBe(
      401,
    );
    expect((await call('GET', '/api/pr')).status).toBe(200);
  });
});

describe('file, threads, replies', () => {
  it('serves file content and validates params', async () => {
    const { call } = setup();
    expect(await (await call('GET', '/api/file?path=a.ts&ref=abc')).json()).toEqual({
      content: 'content of a.ts@abc',
    });
    expect((await call('GET', '/api/file?path=a.ts')).status).toBe(400);
  });

  it('lists threads and posts replies', async () => {
    const { call, github } = setup();
    expect(await (await call('GET', '/api/threads')).json()).toEqual({ threads: [] });
    const res = await call('POST', '/api/threads/123/replies', { body: 'thanks' });
    expect(res.status).toBe(200);
    expect(github.calls.replies).toEqual([{ id: 123, body: 'thanks' }]);
    expect((await call('POST', '/api/threads/abc/replies', { body: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/threads/1/replies', { body: ' ' })).status).toBe(400);
  });
});

describe('drafts', () => {
  it('upserts, lists and deletes', async () => {
    const { call } = setup();
    const created = await (await call('PUT', '/api/drafts', draft)).json();
    expect(created.draft.id).toBeTruthy();
    const edited = await (
      await call('PUT', '/api/drafts', { ...draft, id: created.draft.id, body: 'v2' })
    ).json();
    expect(edited.draft.body).toBe('v2');
    const list = await (await call('GET', '/api/drafts')).json();
    expect(list.drafts).toHaveLength(1);
    expect((await call('DELETE', `/api/drafts/${created.draft.id}`)).status).toBe(200);
    expect((await call('DELETE', `/api/drafts/${created.draft.id}`)).status).toBe(404);
  });

  it('validates bodies', async () => {
    const { call } = setup();
    expect((await call('PUT', '/api/drafts', { ...draft, side: 'MIDDLE' })).status).toBe(400);
    expect((await call('PUT', '/api/drafts', { ...draft, body: '  ' })).status).toBe(400);
    expect((await call('PUT', '/api/drafts', { ...draft, line: 2, startLine: 5 })).status).toBe(
      400,
    );
    expect((await call('PUT', '/api/drafts', { path: 'x' })).status).toBe(400);
  });
});

describe('POST /api/review', () => {
  it('submits inline + fallback drafts, records, and clears drafts', async () => {
    const { call, github } = setup();
    await call('PUT', '/api/drafts', draft);
    await call('PUT', '/api/drafts', { ...draft, line: 99, body: 'outside' });
    const res = await call('POST', '/api/review', { event: 'COMMENT', body: 'overall' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reviewUrl).toContain('pullrequestreview-42');
    expect(json.fallbacks).toHaveLength(1);
    const sent = github.calls.submitReview[0]!;
    expect(sent.headSha).toBe(HEAD);
    expect(sent.comments).toHaveLength(1);
    expect(sent.body).toBe('overall\n\n`src/greet.ts:99` — outside');
    expect((await (await call('GET', '/api/drafts')).json()).drafts).toEqual([]);
  });

  it('returns 409 when head moved, and submits with force against the new head', async () => {
    const { call, github } = setup();
    await call('PUT', '/api/drafts', draft);
    github.setHead('3333333333333333333333333333333333333333');
    const res = await call('POST', '/api/review', { event: 'COMMENT' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'head_moved' });
    expect(github.calls.submitReview).toHaveLength(0);
    const forced = await call('POST', '/api/review', { event: 'COMMENT', force: true });
    expect(forced.status).toBe(200);
    expect(github.calls.submitReview[0]?.headSha).toBe('3333333333333333333333333333333333333333');
  });

  it('rejects APPROVE on a self-review', async () => {
    const { call, github } = setup({ viewer: 'octocat' });
    await call('PUT', '/api/drafts', draft);
    const res = await call('POST', '/api/review', { event: 'APPROVE' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'self_review' });
    expect(github.calls.submitReview).toHaveLength(0);
    expect((await (await call('GET', '/api/pr')).json()).isSelfReview).toBe(true);
  });

  it('validates the event', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/review', { event: 'NOPE' })).status).toBe(400);
  });
});
