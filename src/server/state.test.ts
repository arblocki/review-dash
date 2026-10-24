import { describe, expect, it } from 'vitest';
import { parseFile } from '../core/diff/parse.js';
import type { RawFile } from '../core/diff/types.js';
import { openStore } from '../core/store/index.js';
import { fakeGitHub, loadFixture } from '../core/testing/fakes.testutil.js';
import { createApp } from './app.js';
import { TOKEN_HEADER } from './security.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PORT = 4321;
const pr = { owner: 'octocat', repo: 'hello-world', number: 1 };
const fixture = loadFixture();
const HEAD = fixture.pr.headSha;
const HEAD2 = '3333333333333333333333333333333333333333';
const hunkIds = fixture.files.flatMap((f) => parseFile(f).hunks.map((h) => h.id));

function setup() {
  const github = fakeGitHub();
  const store = openStore(':memory:');
  const app = createApp({ token: 't', pr, port: () => PORT, github, store });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        host: `127.0.0.1:${PORT}`,
        [TOKEN_HEADER]: 't',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  return { github, store, call };
}

describe('review state routes', () => {
  it('starts empty', async () => {
    const { call } = setup();
    const r = await call('GET', '/api/review-state');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ reviewedHunkIds: [], reviewedAt: {}, verifyChecks: {} });
  });

  it('marks and unmarks hunks, recording the head', async () => {
    const { call } = setup();
    const [a, b] = hunkIds;
    expect((await call('PUT', '/api/reviewed', { hunkIds: [a, b], reviewed: true })).status).toBe(
      200,
    );
    let s = (await call('GET', '/api/review-state')).json;
    expect([...s.reviewedHunkIds].sort()).toEqual([a, b].sort());
    expect(s.reviewedAt[a!]).toMatchObject({ headSha: HEAD });
    expect(typeof s.reviewedAt[a!].reviewedAt).toBe('string');
    expect(s.lastReviewedHeadSha).toBe(HEAD);

    await call('PUT', '/api/reviewed', { hunkIds: [a], reviewed: false });
    s = (await call('GET', '/api/review-state')).json;
    expect(s.reviewedHunkIds).toEqual([b]);
  });

  it('stores verify checks per group', async () => {
    const { call } = setup();
    await call('PUT', '/api/verify', { groupKey: 'g1', itemIndex: 1, checked: true });
    await call('PUT', '/api/verify', { groupKey: 'g1', itemIndex: 0, checked: true });
    await call('PUT', '/api/verify', { groupKey: 'g1', itemIndex: 0, checked: false });
    await call('PUT', '/api/verify', { groupKey: 'g2', itemIndex: 2, checked: true });
    const s = (await call('GET', '/api/review-state')).json;
    expect(s.verifyChecks).toEqual({ g1: [1], g2: [2] });
  });

  it('validates bodies', async () => {
    const { call } = setup();
    expect((await call('PUT', '/api/reviewed', { hunkIds: 'x', reviewed: true })).status).toBe(400);
    expect(
      (await call('PUT', '/api/verify', { groupKey: '', itemIndex: 0, checked: true })).status,
    ).toBe(400);
  });
});

describe('GET /api/interdiff', () => {
  it('reports nothing to compare before any review', async () => {
    const { call } = setup();
    const r = await call('GET', '/api/interdiff');
    expect(r.json).toMatchObject({
      lastReviewedHeadSha: null,
      currentHeadSha: HEAD,
      newCommits: [],
      changedFiles: [],
      compareAvailable: false,
    });
    expect(r.json.newHunkIds).toEqual(hunkIds);
  });

  it('lists new commits, files and unreviewed hunks after a push', async () => {
    const { call, github, store } = setup();
    store.markReviewed(pr, [hunkIds[0]!], 'old-head');
    github.compare = {
      commits: [{ sha: 'c1', message: 'fix', author: 'octocat', date: '2026-01-02T00:00:00Z' }],
      files: ['src/greet.ts'],
    };
    const r = await call('GET', '/api/interdiff');
    expect(github.calls.compare).toEqual([{ base: 'old-head', head: HEAD }]);
    expect(r.json).toEqual({
      lastReviewedHeadSha: 'old-head',
      currentHeadSha: HEAD,
      newCommits: github.compare.commits,
      changedFiles: ['src/greet.ts'],
      newHunkIds: hunkIds.slice(1),
      compareAvailable: true,
    });
  });

  it('still returns new hunks when the old head was force-pushed away', async () => {
    const { call, github, store } = setup();
    store.markReviewed(pr, [hunkIds[0]!], 'gone');
    github.compare = undefined;
    const r = await call('GET', '/api/interdiff');
    expect(r.json).toMatchObject({
      lastReviewedHeadSha: 'gone',
      compareAvailable: false,
      newCommits: [],
      changedFiles: [],
    });
    expect(r.json.newHunkIds).toEqual(hunkIds.slice(1));
  });

  it('skips the compare call when the head has not moved', async () => {
    const { call, github, store } = setup();
    store.markReviewed(pr, [hunkIds[0]!], HEAD);
    const r = await call('GET', '/api/interdiff');
    expect(github.calls.compare).toEqual([]);
    expect(r.json).toMatchObject({ compareAvailable: true, newCommits: [] });
  });
});

describe('draft re-anchoring', () => {
  const greet = fixture.files[0]!;
  const hunk = parseFile(greet).hunks[0]!;
  // `export const retries = 3;` is new line 7 of the first hunk.
  const target = hunk.lines.find((l) => l.content === 'export const retries = 3;')!;

  const shiftedFiles = (patchEdit: (p: string) => string): RawFile[] =>
    fixture.files.map((f) => (f === greet ? { ...f, patch: patchEdit(f.patch!) } : f));

  async function draftThenPush(files: RawFile[]) {
    const s = setup();
    const put = await s.call('PUT', '/api/drafts', {
      path: 'src/greet.ts',
      side: 'RIGHT',
      line: target.newLine,
      body: 'why 3?',
      hunkId: hunk.id,
      headSha: HEAD,
    });
    expect(put.json.draft.anchor).toBeDefined();
    s.github.setHead(HEAD2);
    s.github.fetchFiles = async () => files;
    await s.call('GET', '/api/pr?refresh=1');
    return s;
  }

  it('moves a draft whose hunk shifted down', async () => {
    const { call } = await draftThenPush(
      shiftedFiles((p) => p.replace('@@ -1,5 +1,8 @@', '@@ -1,5 +11,8 @@')),
    );
    const { drafts } = (await call('GET', '/api/drafts')).json;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      line: (target.newLine ?? 0) + 10,
      headSha: HEAD2,
      outdated: false,
    });
  });

  it('marks a draft outdated when its hunk changed', async () => {
    const { call } = await draftThenPush(
      shiftedFiles((p) => p.replace('retries = 3', 'retries = 5')),
    );
    const { drafts } = (await call('GET', '/api/drafts')).json;
    expect(drafts[0]).toMatchObject({ outdated: true, headSha: HEAD, line: target.newLine });
  });

  it('marks a draft outdated when its hunk is gone', async () => {
    const { call } = await draftThenPush(fixture.files.filter((f) => f !== greet));
    const { drafts } = (await call('GET', '/api/drafts')).json;
    expect(drafts[0]?.outdated).toBe(true);
  });

  it('submits outdated drafts in the body only, without needing force', async () => {
    const { call, github, store } = await draftThenPush(
      shiftedFiles((p) => p.replace('retries = 3', 'retries = 5')),
    );
    const r = await call('POST', '/api/review', {
      event: 'COMMENT',
      body: 'overall',
      headSha: HEAD2,
    });
    expect(r.status).toBe(200);
    const sent = github.calls.submitReview[0]!;
    expect(sent.comments).toEqual([]);
    expect(sent.body).toContain('overall');
    expect(sent.body).toContain('outdated');
    expect(sent.body).toContain('why 3?');
    expect(store.listDrafts(pr)).toEqual([]);
  });

  it('moves drafts and submits them inline after a push', async () => {
    const { call, github } = await draftThenPush(
      shiftedFiles((p) => p.replace('@@ -1,5 +1,8 @@', '@@ -1,5 +11,8 @@')),
    );
    const r = await call('POST', '/api/review', { event: 'COMMENT', body: '', headSha: HEAD2 });
    expect(r.status).toBe(200);
    expect(github.calls.submitReview[0]!.comments).toMatchObject([
      { path: 'src/greet.ts', line: (target.newLine ?? 0) + 10, body: 'why 3?' },
    ]);
  });
});
