import { describe, expect, it } from 'vitest';
import { diffHash, parseFile } from '../core/diff/parse.js';
import type { RawFile } from '../core/diff/types.js';
import { fnv1a8 } from '../core/hash.js';
import { fileReviewKey } from '../core/review-items.js';
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
const DIFF_HASH = diffHash(fixture.files.map(parseFile));
const at = { headSha: HEAD, diffHash: DIFF_HASH };

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
    expect(
      (await call('PUT', '/api/reviewed', { hunkIds: [a, b], reviewed: true, ...at })).status,
    ).toBe(200);
    let s = (await call('GET', '/api/review-state')).json;
    expect([...s.reviewedHunkIds].sort()).toEqual([a, b].sort());
    expect(s.reviewedAt[a!]).toMatchObject({ headSha: HEAD });
    expect(typeof s.reviewedAt[a!].reviewedAt).toBe('string');
    expect(s.reviewBaselineHeadSha).toBe(HEAD);

    await call('PUT', '/api/reviewed', { hunkIds: [a], reviewed: false, ...at });
    s = (await call('GET', '/api/review-state')).json;
    expect(s.reviewedHunkIds).toEqual([b]);
  });

  it('stores verify checks per group and item text', async () => {
    const { call, store } = setup();
    const X = fnv1a8('check X');
    const Y = fnv1a8('check Y');
    const put = (groupKey: string, itemIndex: number, itemHash: string, checked: boolean) =>
      call('PUT', '/api/verify', { groupKey, itemIndex, itemHash, checked });
    await put('g1', 1, X, true);
    await put('g1', 0, X, true);
    await put('g1', 0, X, false);
    await put('g2', 2, Y, true);
    // An old-format row (no '#hash') is ignored.
    store.setVerifyCheck(pr, 'legacy', 0, true);
    const s = (await call('GET', '/api/review-state')).json;
    expect(s.verifyChecks).toEqual({
      g1: [{ index: 1, itemHash: X }],
      g2: [{ index: 2, itemHash: Y }],
    });
  });

  it('does not carry a check over to different text at the same index', async () => {
    const { call } = setup();
    const X = fnv1a8('check X');
    const Y = fnv1a8('check Y');
    await call('PUT', '/api/verify', { groupKey: 'g', itemIndex: 0, itemHash: X, checked: true });
    const checkedFor = async (hash: string) =>
      (await call('GET', '/api/review-state')).json.verifyChecks.g?.some(
        (c: Json) => c.index === 0 && c.itemHash === hash,
      ) ?? false;
    expect(await checkedFor(Y)).toBe(false);
    expect(await checkedFor(X)).toBe(true);
  });

  it('validates bodies', async () => {
    const { call } = setup();
    expect(
      (await call('PUT', '/api/reviewed', { hunkIds: 'x', reviewed: true, ...at })).status,
    ).toBe(400);
    expect(
      (
        await call('PUT', '/api/verify', {
          groupKey: '',
          itemIndex: 0,
          itemHash: 'abcdef12',
          checked: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/api/verify', { groupKey: 'g', itemIndex: 0, checked: true })).status,
    ).toBe(400);
  });
});

describe('PUT /api/reviewed validation', () => {
  it('rejects a head the server has moved past and persists nothing', async () => {
    const { call, github, store } = setup();
    expect((await call('GET', '/api/pr')).json.pr.headSha).toBe(HEAD);
    store.markReviewed(pr, [hunkIds[0]!], 'older-head');
    github.setHead(HEAD2);
    const moved = (await call('GET', '/api/pr?refresh=1')).json;
    const r = await call('PUT', '/api/reviewed', { hunkIds: [hunkIds[1]], reviewed: true, ...at });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      code: 'head_moved',
      currentHeadSha: HEAD2,
      currentDiffHash: moved.diffHash,
    });
    expect(store.listReviewed(pr).map((x) => x.hunkId)).toEqual([hunkIds[0]]);
    const inter = (await call('GET', '/api/interdiff')).json;
    expect(inter.reviewBaselineHeadSha).toBe('older-head');
    const un = await call('PUT', '/api/reviewed', {
      hunkIds: [hunkIds[0]],
      reviewed: false,
      ...at,
    });
    expect(un.status).toBe(409);
    expect(store.listReviewed(pr)).toHaveLength(1);
  });

  it('rejects a matching head with a different diff hash', async () => {
    const { call, store } = setup();
    const r = await call('PUT', '/api/reviewed', {
      hunkIds: [hunkIds[0]],
      reviewed: true,
      headSha: HEAD,
      diffHash: 'stale',
    });
    expect(r.status).toBe(409);
    expect(store.listReviewed(pr)).toEqual([]);
  });

  it('rejects unknown ids with 400 and writes nothing', async () => {
    const { call, store } = setup();
    const r = await call('PUT', '/api/reviewed', {
      hunkIds: [hunkIds[0], 'bogus', 'file:nope@x'],
      reviewed: true,
      ...at,
    });
    expect(r.status).toBe(400);
    expect(r.json.unknown).toEqual(['bogus', 'file:nope@x']);
    expect(store.listReviewed(pr)).toEqual([]);
  });

  it('accepts the review key of a hunkless file', async () => {
    const binary: RawFile = {
      filename: 'img/logo.png',
      status: 'added',
      additions: 0,
      deletions: 0,
      sha: 'blob123',
    };
    const github = fakeGitHub({ files: [...fixture.files, binary] });
    const store = openStore(':memory:');
    const app = createApp({ token: 't', pr, port: () => PORT, github, store });
    const headers = {
      host: `127.0.0.1:${PORT}`,
      [TOKEN_HEADER]: 't',
      'content-type': 'application/json',
    };
    const info = await (await app.request('/api/pr', { headers })).json();
    const key = fileReviewKey(parseFile(binary), HEAD);
    expect(key).toBe('file:img/logo.png@blob123');
    const res = await app.request('/api/reviewed', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        hunkIds: [key],
        reviewed: true,
        headSha: HEAD,
        diffHash: (info as Json).diffHash,
      }),
    });
    expect(res.status).toBe(200);
    expect(store.listReviewed(pr).map((x) => x.hunkId)).toEqual([key]);
  });
});

describe('GET /api/interdiff', () => {
  it('reports nothing to compare before any review', async () => {
    const { call } = setup();
    const r = await call('GET', '/api/interdiff');
    expect(r.json).toMatchObject({
      reviewBaselineHeadSha: null,
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
      totalCommits: 1,
    };
    const r = await call('GET', '/api/interdiff');
    expect(github.calls.compare).toEqual([{ base: 'old-head', head: HEAD }]);
    expect(r.json).toEqual({
      reviewBaselineHeadSha: 'old-head',
      currentHeadSha: HEAD,
      newCommits: github.compare.commits,
      changedFiles: ['src/greet.ts'],
      newHunkIds: hunkIds.slice(1),
      compareAvailable: true,
      totalCommits: 1,
      commitsTruncated: false,
      filesTruncated: false,
    });
  });

  it('surfaces truncation flags from the compare', async () => {
    const { call, github, store } = setup();
    store.markReviewed(pr, [hunkIds[0]!], 'old-head');
    github.compare = {
      commits: [],
      files: [],
      totalCommits: 2500,
      commitsTruncated: true,
      filesTruncated: true,
    };
    const r = await call('GET', '/api/interdiff');
    expect(r.json).toMatchObject({
      totalCommits: 2500,
      commitsTruncated: true,
      filesTruncated: true,
    });
  });

  it('still returns new hunks when the old head was force-pushed away', async () => {
    const { call, github, store } = setup();
    store.markReviewed(pr, [hunkIds[0]!], 'gone');
    github.compare = undefined;
    const r = await call('GET', '/api/interdiff');
    expect(r.json).toMatchObject({
      reviewBaselineHeadSha: 'gone',
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

describe('re-review baseline', () => {
  async function pushTo(
    { call, github }: ReturnType<typeof setup>,
    head: string,
  ): Promise<{ headSha: string; diffHash: string }> {
    github.setHead(head);
    const d = (await call('GET', '/api/pr?refresh=1')).json;
    return { headSha: d.pr.headSha, diffHash: d.diffHash };
  }
  const baseline = async (call: ReturnType<typeof setup>['call']) => ({
    state: (await call('GET', '/api/review-state')).json.reviewBaselineHeadSha,
    inter: (await call('GET', '/api/interdiff')).json.reviewBaselineHeadSha,
  });

  it('keeps the baseline at A when one hunk is marked on B', async () => {
    const t = setup();
    const { call, github } = t;
    await call('GET', '/api/pr');
    await call('PUT', '/api/reviewed', { hunkIds: [hunkIds[0]], reviewed: true, ...at });
    const b = await pushTo(t, HEAD2);
    expect(
      (await call('PUT', '/api/reviewed', { hunkIds: [hunkIds[1]], reviewed: true, ...b })).status,
    ).toBe(200);
    // A fresh request ("reload") still compares from A.
    expect(await baseline(call)).toEqual({ state: HEAD, inter: HEAD });
    expect(github.calls.compare.at(-1)).toEqual({ base: HEAD, head: HEAD2 });
  });

  it('moves the baseline to the head named by a checkpoint', async () => {
    const t = setup();
    const { call } = t;
    await call('GET', '/api/pr');
    await call('PUT', '/api/reviewed', { hunkIds: [hunkIds[0]], reviewed: true, ...at });
    const b = await pushTo(t, HEAD2);
    const r = await call('POST', '/api/review-checkpoint', b);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, reviewBaselineHeadSha: HEAD2 });
    expect(await baseline(call)).toEqual({ state: HEAD2, inter: HEAD2 });
  });

  it('refuses a checkpoint for a stale head and records nothing', async () => {
    const t = setup();
    const { call, store } = t;
    await call('GET', '/api/pr');
    await pushTo(t, HEAD2);
    const r = await call('POST', '/api/review-checkpoint', at);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'head_moved', currentHeadSha: HEAD2 });
    expect(store.getReviewBaselineHeadSha(pr)).toBeUndefined();
    expect((await call('POST', '/api/review-checkpoint', { headSha: HEAD2 })).status).toBe(400);
  });

  it('without a checkpoint uses the earliest mark: marks at A and B, head C gives A', async () => {
    const t = setup();
    const { call } = t;
    const HEAD3 = '4444444444444444444444444444444444444444';
    await call('GET', '/api/pr');
    await call('PUT', '/api/reviewed', { hunkIds: [hunkIds[0]], reviewed: true, ...at });
    await new Promise((r) => setTimeout(r, 5));
    const b = await pushTo(t, HEAD2);
    await call('PUT', '/api/reviewed', { hunkIds: [hunkIds[1]], reviewed: true, ...b });
    await pushTo(t, HEAD3);
    expect(await baseline(call)).toEqual({ state: HEAD, inter: HEAD });
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
