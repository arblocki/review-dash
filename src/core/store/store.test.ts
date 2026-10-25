import { describe, expect, it } from 'vitest';
import { openStore } from './index.js';

const ref = { owner: 'o', repo: 'r', number: 1 };
const other = { owner: 'o', repo: 'r', number: 2 };
const base = { path: 'a.ts', side: 'RIGHT' as const, line: 3, body: 'hi', headSha: 'abc' };

describe('store drafts', () => {
  it('creates, lists, updates and deletes', () => {
    const s = openStore(':memory:');
    expect(s.listDrafts(ref)).toEqual([]);
    const d = s.upsertDraft(ref, { ...base, startLine: 1, hunkId: 'h1' });
    expect(d).toMatchObject({ path: 'a.ts', startLine: 1, startSide: 'RIGHT', hunkId: 'h1' });
    expect(d.id).toBeTruthy();

    const updated = s.upsertDraft(ref, { ...base, id: d.id, body: 'changed' });
    expect(updated.id).toBe(d.id);
    expect(updated.body).toBe('changed');
    expect(updated.startLine).toBeUndefined();
    expect(s.listDrafts(ref)).toHaveLength(1);

    expect(s.deleteDraft(ref, d.id)).toBe(true);
    expect(s.deleteDraft(ref, d.id)).toBe(false);
    expect(s.listDrafts(ref)).toEqual([]);
  });

  it('scopes drafts to a pull request', () => {
    const s = openStore(':memory:');
    const d = s.upsertDraft(ref, base);
    expect(s.listDrafts(other)).toEqual([]);
    expect(s.deleteDraft(other, d.id)).toBe(false);
    expect(() => s.upsertDraft(other, { ...base, id: d.id })).toThrow(/different pull request/);
    expect(s.listDrafts(ref)[0]?.body).toBe('hi');
  });

  it('deletes several drafts and records submitted reviews', () => {
    const s = openStore(':memory:');
    const a = s.upsertDraft(ref, base);
    const b = s.upsertDraft(ref, { ...base, line: 9 });
    s.deleteDrafts(ref, [a.id, b.id]);
    expect(s.listDrafts(ref)).toEqual([]);
    expect(() =>
      s.recordSubmittedReview(ref, { headSha: 'abc', event: 'COMMENT', githubReviewId: 5 }),
    ).not.toThrow();
  });

  it('bumps the revision on every upsert, even within the same millisecond', () => {
    const s = openStore(':memory:');
    const a = s.upsertDraft(ref, base);
    expect(a.revision).toBe(1);
    const b = s.upsertDraft(ref, { ...base, id: a.id });
    expect(b.revision).toBe(2);
  });

  it('deletes only drafts unchanged since the snapshot and reports the rest', () => {
    const s = openStore(':memory:');
    const a = s.upsertDraft(ref, base);
    const b = s.upsertDraft(ref, { ...base, line: 9 });
    const c = s.upsertDraft(ref, { ...base, line: 10 });
    const snapshot = [a, b, c].map((d) => ({ id: d.id, revision: d.revision }));
    s.upsertDraft(ref, { ...base, id: b.id, line: 9, body: 'edited' });
    s.deleteDraft(ref, c.id); // removed by the user meanwhile: nothing to keep
    expect(s.deleteDraftsIfUnchanged(ref, snapshot)).toEqual([b.id]);
    expect(s.listDrafts(ref).map((d) => [d.id, d.body])).toEqual([[b.id, 'edited']]);
  });
});
