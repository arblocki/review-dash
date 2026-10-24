import { describe, expect, it } from 'vitest';
import { parseFile } from './diff/parse.js';
import { computeAnchor, reanchorDraft } from './reanchor.js';
import type { Draft } from './store/index.js';

const BODY = ['@@ -10,4 +10,5 @@ fn', ' a', '-b', '+b2', '+b3', ' c', ' d'].join('\n');

function file(patch: string, path = 'src/x.ts') {
  return parseFile({ filename: path, status: 'modified', additions: 2, deletions: 1, patch });
}

const before = file(BODY);
const hunk = before.hunks[0]!;

function draftAt(over: Partial<Draft> = {}): Draft {
  const anchor = computeAnchor(hunk, { line: 12, side: 'RIGHT' })!;
  return {
    id: 'd',
    path: 'src/x.ts',
    side: 'RIGHT',
    line: 12,
    body: 'hm',
    revision: 1,
    hunkId: hunk.id,
    headSha: 'old',
    outdated: false,
    anchor,
    updatedAt: '',
    ...over,
  };
}

describe('computeAnchor', () => {
  it('records index and text, including the range start', () => {
    expect(
      computeAnchor(hunk, { line: 12, side: 'RIGHT', startLine: 11, startSide: 'RIGHT' }),
    ).toEqual({
      index: 3,
      startIndex: 2,
      text: 'b3',
    });
    expect(computeAnchor(hunk, { line: 99, side: 'RIGHT' })).toBeUndefined();
    expect(computeAnchor(hunk, { line: 11, side: 'LEFT' })).toEqual({ index: 1, text: 'b' });
  });
});

describe('reanchorDraft', () => {
  it('leaves drafts on the current head and outdated drafts alone', () => {
    expect(reanchorDraft(draftAt(), [before], 'old')).toEqual({ kind: 'unchanged' });
    expect(reanchorDraft(draftAt({ outdated: true }), [before], 'new')).toEqual({
      kind: 'unchanged',
    });
  });

  it('follows the hunk when lines above it shifted', () => {
    const shifted = file(BODY.replace('@@ -10,4 +10,5', '@@ -40,4 +43,5'));
    expect(shifted.hunks[0]!.id).toBe(hunk.id);
    expect(reanchorDraft(draftAt(), [shifted], 'new')).toEqual({ kind: 'moved', line: 45 });
    const range = draftAt({
      startLine: 11,
      anchor: computeAnchor(hunk, { line: 12, side: 'RIGHT', startLine: 11 })!,
    });
    expect(reanchorDraft(range, [shifted], 'new')).toEqual({
      kind: 'moved',
      line: 45,
      startLine: 44,
    });
    const left = draftAt({
      side: 'LEFT',
      line: 11,
      anchor: computeAnchor(hunk, { line: 11, side: 'LEFT' })!,
    });
    expect(reanchorDraft(left, [shifted], 'new')).toEqual({ kind: 'moved', line: 41 });
  });

  it('marks drafts outdated when the hunk changed or vanished', () => {
    const changed = file(BODY.replace('+b3', '+b4'));
    expect(reanchorDraft(draftAt(), [changed], 'new')).toEqual({ kind: 'outdated' });
    expect(reanchorDraft(draftAt(), [file('', 'src/x.ts')], 'new')).toEqual({ kind: 'outdated' });
    expect(reanchorDraft(draftAt(), [], 'new')).toEqual({ kind: 'outdated' });
  });

  it('marks drafts outdated when the anchored text no longer matches or is missing', () => {
    const shifted = file(BODY.replace('@@ -10,4 +10,5', '@@ -40,4 +43,5'));
    const stale = draftAt({ anchor: { index: 3, text: 'something else' } });
    expect(reanchorDraft(stale, [shifted], 'new')).toEqual({ kind: 'outdated' });
    expect(reanchorDraft(draftAt({ anchor: undefined }), [shifted], 'new')).toEqual({
      kind: 'outdated',
    });
    expect(reanchorDraft(draftAt({ hunkId: undefined }), [shifted], 'new')).toEqual({
      kind: 'outdated',
    });
  });
});
