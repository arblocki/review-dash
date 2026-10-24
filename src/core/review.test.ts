import { describe, expect, it } from 'vitest';
import { parseFile } from './diff/parse.js';
import { buildReview, ReviewError, type BuildReviewInput } from './review.js';
import type { Draft } from './store/index.js';
import { loadFixture } from './testing/fakes.testutil.js';

const HEAD = loadFixture().pr.headSha;
const files = loadFixture().files.map(parseFile);

function draft(over: Partial<Draft>): Draft {
  return {
    id: 'd1',
    path: 'src/greet.ts',
    side: 'RIGHT',
    line: 2,
    body: 'nit',
    headSha: HEAD,
    outdated: false,
    updatedAt: '2026-01-01T00:00:00Z',
    revision: 1,
    ...over,
  };
}

function input(over: Partial<BuildReviewInput> = {}): BuildReviewInput {
  return {
    drafts: [draft({})],
    files,
    event: 'COMMENT',
    body: '',
    viewer: 'reviewer',
    prAuthor: 'octocat',
    currentHeadSha: HEAD,
    reviewedHeadSha: HEAD,
    ...over,
  };
}

describe('buildReview', () => {
  it('maps commentable drafts to inline comments', () => {
    const r = buildReview(
      input({
        drafts: [
          draft({ id: 'a' }),
          draft({ id: 'b', side: 'LEFT', line: 2 }),
          draft({ id: 'c', line: 4, startLine: 2 }),
        ],
        body: 'overall',
      }),
    );
    expect(r.fallbacks).toEqual([]);
    expect(r.payload).toEqual({
      headSha: HEAD,
      event: 'COMMENT',
      body: 'overall',
      comments: [
        { path: 'src/greet.ts', body: 'nit', line: 2, side: 'RIGHT' },
        { path: 'src/greet.ts', body: 'nit', line: 2, side: 'LEFT' },
        {
          path: 'src/greet.ts',
          body: 'nit',
          line: 4,
          side: 'RIGHT',
          start_line: 2,
          start_side: 'RIGHT',
        },
      ],
    });
  });

  it('folds out-of-hunk drafts into the body and reports them', () => {
    const out = draft({ id: 'x', line: 99, body: 'why?' });
    const range = draft({ id: 'y', path: 'unknown.ts', line: 7, startLine: 5, body: 'hm' });
    const r = buildReview(input({ drafts: [draft({}), out, range], body: 'summary' }));
    expect(r.payload.comments).toHaveLength(1);
    expect(r.fallbacks.map((d) => d.id)).toEqual(['x', 'y']);
    expect(r.payload.body).toBe('summary\n\n`src/greet.ts:99` — why?\n\n`unknown.ts:5-7` — hm');
    expect(r.included).toHaveLength(3);
  });

  it('rejects APPROVE and REQUEST_CHANGES on a self-review', () => {
    for (const event of ['APPROVE', 'REQUEST_CHANGES'] as const) {
      expect(() => buildReview(input({ event, viewer: 'OctoCat' }))).toThrow(/own pull request/);
    }
    expect(buildReview(input({ viewer: 'octocat' })).payload.event).toBe('COMMENT');
  });

  it('returns a 409 when the head moved, unless forced', () => {
    const stale = [draft({ headSha: 'old' })];
    try {
      buildReview(input({ drafts: stale }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewError);
      expect(e).toMatchObject({ status: 409, code: 'head_moved' });
    }
    const r = buildReview(input({ drafts: stale, force: true }));
    expect(r.payload.headSha).toBe(HEAD);
  });

  it('never posts drafts from an older head inline, even when forced', () => {
    const old = draft({ id: 'o', headSha: 'abc1234def', line: 2, body: 'stale' });
    const cur = draft({ id: 'c', line: 99, body: 'out' });
    const r = buildReview(input({ drafts: [draft({ id: 'k' }), old, cur], force: true }));
    expect(r.payload.comments.map((c) => c.body)).toEqual(['nit']);
    expect(r.outdated.map((d) => d.id)).toEqual(['o']);
    expect(r.fallbacks.map((d) => d.id)).toEqual(['c']);
    expect(r.included).toHaveLength(3);
    expect(r.payload.body).toBe(
      '`src/greet.ts:99` — out\n\n`src/greet.ts:2` (outdated: written against abc1234) — stale',
    );
  });

  it('returns a 409 for a bare approval when the reviewed head is not the current head', () => {
    const moved = input({ drafts: [], event: 'APPROVE', reviewedHeadSha: 'old' });
    expect(() => buildReview(moved)).toThrow(
      expect.objectContaining({ status: 409, code: 'head_moved' }),
    );
    expect(() => buildReview({ ...moved, event: 'COMMENT', body: 'lgtm' })).toThrow(
      expect.objectContaining({ code: 'head_moved' }),
    );
    expect(buildReview({ ...moved, force: true }).payload.headSha).toBe(HEAD);
  });

  it('refuses an empty review but allows a bare approval', () => {
    expect(() => buildReview(input({ drafts: [] }))).toThrow(/Nothing to submit/);
    expect(buildReview(input({ drafts: [], event: 'APPROVE' })).payload.comments).toEqual([]);
  });

  it('puts outdated drafts in the body with a note, never inline', () => {
    const r = buildReview(
      input({
        drafts: [draft({ id: 'a' }), draft({ id: 'b', line: 3, outdated: true, headSha: 'old' })],
      }),
    );
    expect(r.payload.comments.map((c) => c.line)).toEqual([2]);
    expect(r.outdated.map((d) => d.id)).toEqual(['b']);
    expect(r.fallbacks).toEqual([]);
    expect(r.included.map((d) => d.id)).toEqual(['a', 'b']);
    expect(r.payload.body).toContain('`src/greet.ts:3` (outdated');
    expect(r.payload.body).toContain('— nit');
  });

  it('does not treat outdated drafts as stale head drafts', () => {
    const r = buildReview(
      input({ drafts: [draft({ outdated: true, headSha: 'old' })], body: 'x' }),
    );
    expect(r.payload.comments).toEqual([]);
    expect(r.outdated).toHaveLength(1);
  });
});
