import { describe, expect, it } from 'vitest';
import type { DiffLine, Hunk } from '../../core/diff/types';
import {
  applyExpansions,
  changeKey,
  changePosition,
  expansionRange,
  findChangeKey,
  findHunk,
  gapAfter,
  gapBefore,
  hideWhitespaceOnly,
  isInlineRange,
  keysBetween,
  selectRange,
  sourceLines,
  toRdvHunks,
} from './diffModel';
import { highlightHunks, languageForPath } from './highlight';

const ctx = (o: number, n: number, content = `c${n}`): DiffLine => ({
  type: 'context',
  content,
  oldLine: o,
  newLine: n,
});
const del = (o: number, content = `d${o}`): DiffLine => ({ type: 'del', content, oldLine: o });
const add = (n: number, content = `a${n}`): DiffLine => ({ type: 'add', content, newLine: n });

function hunk(
  id: string,
  oldStart: number,
  newStart: number,
  lines: DiffLine[],
  header = `@@ -${oldStart} +${newStart} @@`,
): Hunk {
  return {
    id,
    path: 'a.ts',
    status: 'modified',
    oldStart,
    newStart,
    oldLines: lines.filter((l) => l.type !== 'add').length,
    newLines: lines.filter((l) => l.type !== 'del').length,
    header,
    lines,
  };
}

// old: 10 11 12(del) 13   new: 10 11 12(add) 13(add) 14
const h1 = hunk('h1', 10, 10, [ctx(10, 10), ctx(11, 11), del(12), add(12), add(13), ctx(13, 14)]);
const h2 = hunk('h2', 30, 31, [ctx(30, 31), del(31), ctx(32, 32)]);

describe('toRdvHunks', () => {
  const [r1] = toRdvHunks([h1]);

  it('copies hunk bounds and header', () => {
    expect(r1).toMatchObject({
      content: '@@ -10 +10 @@',
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 5,
    });
  });

  it('maps line types and numbers', () => {
    expect(r1?.changes).toEqual([
      { type: 'normal', isNormal: true, content: 'c10', oldLineNumber: 10, newLineNumber: 10 },
      { type: 'normal', isNormal: true, content: 'c11', oldLineNumber: 11, newLineNumber: 11 },
      { type: 'delete', isDelete: true, content: 'd12', lineNumber: 12 },
      { type: 'insert', isInsert: true, content: 'a12', lineNumber: 12 },
      { type: 'insert', isInsert: true, content: 'a13', lineNumber: 13 },
      { type: 'normal', isNormal: true, content: 'c14', oldLineNumber: 13, newLineNumber: 14 },
    ]);
  });
});

describe('side/line mapping', () => {
  const [r1] = toRdvHunks([h1]);
  const changes = r1!.changes;

  it('maps deleted lines to LEFT + old line', () => {
    expect(changePosition(changes[2]!)).toEqual({ side: 'LEFT', line: 12 });
  });

  it('maps added lines to RIGHT + new line', () => {
    expect(changePosition(changes[3]!)).toEqual({ side: 'RIGHT', line: 12 });
  });

  it('maps context lines to RIGHT + new line, not the old one', () => {
    expect(changePosition(changes[5]!)).toEqual({ side: 'RIGHT', line: 14 });
  });

  it('keys changes like react-diff-view', () => {
    expect(changes.map(changeKey)).toEqual(['N10', 'N11', 'D12', 'I12', 'I13', 'N13']);
  });

  it('finds the widget key for a thread position', () => {
    const hunks = toRdvHunks([h1, h2]);
    expect(findChangeKey(hunks, { side: 'RIGHT', line: 12 })).toBe('I12');
    expect(findChangeKey(hunks, { side: 'LEFT', line: 12 })).toBe('D12');
    expect(findChangeKey(hunks, { side: 'RIGHT', line: 14 })).toBe('N13');
    expect(findChangeKey(hunks, { side: 'LEFT', line: 13 })).toBe('N13'); // LEFT on context
    expect(findChangeKey(hunks, { side: 'RIGHT', line: 20 })).toBeUndefined();
  });

  it('finds the original hunk for a position', () => {
    expect(findHunk([h1, h2], { side: 'RIGHT', line: 31 })?.id).toBe('h2');
    expect(findHunk([h1, h2], { side: 'LEFT', line: 31 })?.id).toBe('h2');
    expect(findHunk([h1, h2], { side: 'LEFT', line: 14 })).toBeUndefined();
  });
});

describe('selectRange', () => {
  const hunks = toRdvHunks([h1, h2]);

  it('single click yields one line', () => {
    expect(selectRange(hunks, 'I13', 'I13')).toEqual({ line: 13, side: 'RIGHT' });
    expect(selectRange(hunks, 'D12', 'D12')).toEqual({ line: 12, side: 'LEFT' });
  });

  it('orders a downward range', () => {
    expect(selectRange(hunks, 'N11', 'I13')).toEqual({
      line: 13,
      side: 'RIGHT',
      startLine: 11,
      startSide: 'RIGHT',
    });
  });

  it('orders an upward (reversed) range the same way', () => {
    expect(selectRange(hunks, 'I13', 'N11')).toEqual(selectRange(hunks, 'N11', 'I13'));
  });

  it('allows mixed sides: deleted line to added line', () => {
    expect(selectRange(hunks, 'D12', 'I13')).toEqual({
      line: 13,
      side: 'RIGHT',
      startLine: 12,
      startSide: 'LEFT',
    });
  });

  it('returns null for unknown keys', () => {
    expect(selectRange(hunks, 'N99', 'I13')).toBeNull();
  });

  it('lists the keys covered by the selection', () => {
    expect(keysBetween(hunks, 'I13', 'D12')).toEqual(['D12', 'I12', 'I13']);
  });

  it('ranges within one hunk are inline; across hunks they are not', () => {
    const within = selectRange(hunks, 'N11', 'I13')!;
    const across = selectRange(hunks, 'I13', 'N32')!;
    expect(isInlineRange([h1, h2], within)).toBe(true);
    expect(isInlineRange([h1, h2], across)).toBe(false);
  });
});

describe('context expansion', () => {
  const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);

  it('computes gaps in old-line numbers', () => {
    const hunks = toRdvHunks([h1, h2]);
    expect(gapBefore(hunks, 0)).toEqual({ start: 1, end: 10 });
    expect(gapBefore(hunks, 1)).toEqual({ start: 14, end: 30 });
    expect(gapAfter(hunks, 40)).toEqual({ start: 33, end: 41 });
  });

  it('picks ranges for up / down / all', () => {
    const gap = { start: 14, end: 30 };
    expect(expansionRange(gap, 'up', 5)).toEqual([25, 30]);
    expect(expansionRange(gap, 'down', 5)).toEqual([14, 19]);
    expect(expansionRange(gap, 'up', 100)).toEqual([14, 30]);
    expect(expansionRange(gap, 'all')).toEqual([14, 30]);
    expect(expansionRange({ start: 5, end: 5 }, 'all')).toBeNull();
  });

  it('never expands across hunks that are not displayed', () => {
    const gap = { start: 14, end: 60 };
    const hidden = [{ oldStart: 30, oldLines: 4 }];
    expect(expansionRange(gap, 'all', 20, hidden)).toBeNull();
    expect(expansionRange(gap, 'up', 40, hidden)).toEqual([34, 60]);
    expect(expansionRange(gap, 'down', 40, hidden)).toEqual([14, 30]);
  });

  it('merges expanded context into the hunk list with correct numbering', () => {
    const hunks = toRdvHunks([h1, h2]);
    const [s, e] = expansionRange(gapBefore(hunks, 0), 'up', 3)!;
    const expanded = applyExpansions(hunks, source, [[s, e]]);
    // lines 7..9 are now part of the first hunk (adjacent to it)
    expect(expanded).toHaveLength(2);
    expect(expanded[0]).toMatchObject({ oldStart: 7, newStart: 7, oldLines: 7, newLines: 8 });
    expect(expanded[0]!.changes[0]).toMatchObject({
      type: 'normal',
      content: 'line 7',
      oldLineNumber: 7,
      newLineNumber: 7,
    });
  });

  it('expanding a whole gap joins hunks and maps new line numbers across the shift', () => {
    const hunks = toRdvHunks([h1, h2]);
    const expanded = applyExpansions(hunks, source, [[14, 30]]);
    expect(expanded).toHaveLength(1);
    const lines = expanded[0]!.changes;
    const l14 = lines.find((c) => c.type === 'normal' && c.oldLineNumber === 14);
    // two net added lines in h1 shift new numbering by +1
    expect(l14).toMatchObject({ newLineNumber: 15, content: 'line 14' });
    expect(findChangeKey(expanded, { side: 'RIGHT', line: 15 })).toBe('N14');
  });

  it('is a no-op until the source is loaded', () => {
    const hunks = toRdvHunks([h1]);
    expect(applyExpansions(hunks, undefined, [[1, 10]])).toBe(hunks);
  });

  it('splits file text without a phantom trailing line', () => {
    expect(sourceLines('a\nb\n')).toEqual(['a', 'b']);
    expect(sourceLines('a\nb')).toEqual(['a', 'b']);
    expect(sourceLines('')).toEqual([]);
  });
});

describe('hideWhitespaceOnly', () => {
  it('turns whitespace-only replacement blocks into context and drops empty hunks', () => {
    const ws = hunk('w', 1, 1, [
      ctx(1, 1),
      del(2, '  foo(1)'),
      del(3, 'bar'),
      add(2, '    foo(1)'),
      add(3, 'bar '),
      ctx(4, 4),
    ]);
    const real = hunk('r', 20, 20, [del(20, 'x'), add(20, 'y')]);
    const out = hideWhitespaceOnly([ws, real]);
    expect(out.map((h) => h.id)).toEqual(['r']);
    expect(hideWhitespaceOnly([ws])).toEqual([]);
  });

  it('keeps blocks that change more than whitespace, and positions of converted lines', () => {
    const mixed = hunk('m', 1, 1, [del(1, 'a  b'), add(1, 'a b'), del(2, 'x'), add(2, 'y')]);
    const [out] = hideWhitespaceOnly([mixed]);
    expect(out?.lines.map((l) => l.type)).toEqual(['context', 'del', 'add']);
    expect(out?.lines[0]).toMatchObject({ content: 'a b', oldLine: 1, newLine: 1 });
    // unbalanced block is left alone
    const unbalanced = hunk('u', 1, 1, [del(1, 'a'), add(1, 'a'), add(2, 'b')]);
    expect(hideWhitespaceOnly([unbalanced])[0]?.lines).toHaveLength(3);
  });
});

describe('languageForPath', () => {
  it('maps common extensions and filenames', () => {
    expect(languageForPath('src/a/b.ts')).toBe('typescript');
    expect(languageForPath('x.tsx')).toBe('typescript');
    expect(languageForPath('a/Makefile')).toBe('makefile');
    expect(languageForPath('README.MD')).toBe('markdown');
  });

  it('returns undefined for unknown languages', () => {
    expect(languageForPath('assets/data.weirdext')).toBeUndefined();
    expect(languageForPath('LICENSE')).toBeUndefined();
  });
});

describe('highlightHunks', () => {
  it('produces tokens for known languages and nothing for unknown ones', () => {
    const hunks = toRdvHunks([hunk('t', 1, 1, [add(1, 'export const a = 1;')])]);
    const tokens = highlightHunks(hunks, 'typescript');
    expect(tokens?.new[0]?.some((t) => t.type === 'element')).toBe(true);
    expect(highlightHunks(hunks, undefined)).toBeUndefined();
    expect(highlightHunks(hunks, 'not-a-language')).toBeUndefined();
  });
});
