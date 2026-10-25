import { describe, expect, it } from 'vitest';
import type { Hunk, ParsedFile } from '../types';
import { sectionsFromHunkIds } from './sections';

const hunk = (id: string): Hunk => ({
  id,
  path: 'x',
  status: 'modified',
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  header: '@@',
  lines: [],
});
const file = (path: string, ids: string[]): ParsedFile => ({
  path,
  status: 'modified',
  additions: 0,
  deletions: 0,
  patchMissing: false,
  binary: false,
  hunks: ids.map(hunk),
});

describe('sectionsFromHunkIds', () => {
  const files = [file('a', ['a1', 'a2']), file('b', ['b1']), file('c', ['c1'])];

  it('keeps only the wanted hunks, in file order', () => {
    const s = sectionsFromHunkIds(files, ['c1', 'a2']);
    expect(s.map((x) => [x.file.path, x.hunks.map((h) => h.id)])).toEqual([
      ['a', ['a2']],
      ['c', ['c1']],
    ]);
  });

  it('returns nothing for unknown ids', () => {
    expect(sectionsFromHunkIds(files, ['zzz'])).toEqual([]);
  });
});
