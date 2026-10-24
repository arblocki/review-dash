import { describe, expect, it } from 'vitest';
import type { Hunk, ParsedFile } from '../types';
import { filterSections, firstChangedRange, sectionHunkIds } from './reviewFilter';

const hunk = (id: string, lines: Hunk['lines'] = []): Hunk => ({
  id,
  path: 'a.ts',
  status: 'modified',
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  header: '@@',
  lines,
});
const file = (path: string): ParsedFile => ({ path }) as ParsedFile;

describe('filterSections', () => {
  const sections = [
    { file: file('a'), hunks: [hunk('1'), hunk('2')] },
    { file: file('b'), hunks: [hunk('3')] },
  ];
  it('hides matching hunks and drops emptied files', () => {
    const out = filterSections(sections, (h) => h.id === '3' || h.id === '1');
    expect(sectionHunkIds(out)).toEqual(['2']);
    expect(out).toHaveLength(1);
  });
  it('keeps untouched sections by identity', () => {
    expect(filterSections(sections, () => false)[0]).toBe(sections[0]);
    expect(filterSections(sections, () => true)).toEqual([]);
  });
});

describe('firstChangedRange', () => {
  it('skips leading context and uses the new line for additions', () => {
    const h = hunk('1', [
      { type: 'context', content: 'x', oldLine: 4, newLine: 4 },
      { type: 'add', content: 'y', newLine: 5 },
    ]);
    expect(firstChangedRange(h)).toEqual({ side: 'RIGHT', line: 5 });
  });
  it('uses LEFT and the old line for deletions', () => {
    const h = hunk('1', [{ type: 'del', content: 'y', oldLine: 7 }]);
    expect(firstChangedRange(h)).toEqual({ side: 'LEFT', line: 7 });
  });
  it('returns null for an empty hunk', () => {
    expect(firstChangedRange(hunk('1'))).toBeNull();
  });
});
