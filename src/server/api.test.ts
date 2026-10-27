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

  it('flags a PR whose files exceed what GitHub lists, without failing', async () => {
    const fx = loadFixture();
    const { call } = setup({ pr: { ...fx.pr, changedFiles: 3200 } });
    const res = await call('GET', '/api/pr');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.incomplete).toMatchObject({ fetchedFiles: 4, changedFiles: 3200 });
    expect(json.incomplete.reason).toMatch(/3,000/);
    expect(json.files).toHaveLength(4);
    const complete = await (await setup().call('GET', '/api/pr')).json();
    expect(complete).not.toHaveProperty('incomplete');
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

  it('only compares startLine with line when both are on the same side', async () => {
    const { call } = setup();
    const put = async (over: Record<string, unknown>) =>
      (await call('PUT', '/api/drafts', { ...draft, ...over })).status;
    // Same side (startSide defaults to side), reversed.
    expect(await put({ line: 90, startLine: 100 })).toBe(400);
    expect(await put({ line: 90, startLine: 100, startSide: 'RIGHT' })).toBe(400);
    // LEFT 100 -> RIGHT 90 is a valid forward range; numbers are not comparable across sides.
    expect(await put({ line: 90, startLine: 100, startSide: 'LEFT' })).toBe(200);
    // RIGHT start with a LEFT end is saved (e.g. a context line dragged onto the deleted line
    // below it); isCommentable() keeps it out of inline comments, so it goes in the body.
    expect(await put({ side: 'LEFT', line: 100, startLine: 90, startSide: 'RIGHT' })).toBe(200);
  });
});

describe('POST /api/review', () => {
  it('submits inline + fallback drafts, records, and clears drafts', async () => {
    const { call, github } = setup();
    await call('PUT', '/api/drafts', draft);
    await call('PUT', '/api/drafts', { ...draft, line: 99, body: 'outside' });
    const res = await call('POST', '/api/review', {
      event: 'COMMENT',
      body: 'overall',
      headSha: HEAD,
    });
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

  it('keeps drafts edited while the submission was in flight', async () => {
    const { call, github, store } = setup();
    const a = (await (await call('PUT', '/api/drafts', draft)).json()).draft;
    const b = (await (await call('PUT', '/api/drafts', { ...draft, line: 3 })).json()).draft;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((resolve) => {
      const orig = github.submitReview.bind(github);
      github.submitReview = async (r, input) => {
        resolve();
        await gate;
        return orig(r, input);
      };
    });
    const pending = call('POST', '/api/review', { event: 'COMMENT', headSha: HEAD });
    await entered;
    store.upsertDraft(pr, { ...draft, side: 'RIGHT', id: a.id, body: 'edited meanwhile' });
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).keptDrafts).toEqual([a.id]);
    expect(github.calls.submitReview[0]?.comments.map((c) => c.body)).toEqual(['nit', 'nit']);
    const left = store.listDrafts(pr);
    expect(left.map((d) => [d.id, d.body])).toEqual([[a.id, 'edited meanwhile']]);
    expect(left.some((d) => d.id === b.id)).toBe(false);
  });

  it('submits against the new head, flagging drafts that cannot be re-anchored as outdated', async () => {
    const { call, github } = setup();
    await call('PUT', '/api/drafts', draft); // no hunk anchor, so it cannot follow a push
    github.setHead('3333333333333333333333333333333333333333');
    const list = await (await call('GET', '/api/drafts')).json();
    expect(list.drafts[0]).toMatchObject({ outdated: true, headSha: HEAD });
    const res = await call('POST', '/api/review', {
      event: 'COMMENT',
      headSha: '3333333333333333333333333333333333333333', // after reloading the new head
    });
    expect(res.status).toBe(200);
    const sent = github.calls.submitReview[0]!;
    expect(sent.headSha).toBe('3333333333333333333333333333333333333333');
    expect(sent.comments).toEqual([]);
    expect(sent.body).toContain('outdated');
    expect((await res.json()).outdated).toHaveLength(1);
  });

  it('returns 409 for a bare approval after a new push, with no drafts at all', async () => {
    const { call, github } = setup();
    await call('GET', '/api/pr');
    github.setHead('3333333333333333333333333333333333333333');
    const res = await call('POST', '/api/review', { event: 'APPROVE', headSha: HEAD });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'head_moved',
      reviewedHeadSha: HEAD,
      currentHeadSha: '3333333333333333333333333333333333333333',
    });
    expect(github.calls.submitReview).toHaveLength(0);
  });

  it('rejects APPROVE on a self-review', async () => {
    const { call, github } = setup({ viewer: 'octocat' });
    await call('PUT', '/api/drafts', draft);
    const res = await call('POST', '/api/review', { event: 'APPROVE', headSha: HEAD });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'self_review' });
    expect(github.calls.submitReview).toHaveLength(0);
    expect((await (await call('GET', '/api/pr')).json()).isSelfReview).toBe(true);
  });

  it('validates the event', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/review', { event: 'NOPE', headSha: HEAD })).status).toBe(400);
    expect((await call('POST', '/api/review', { event: 'APPROVE' })).status).toBe(400);
  });
});
