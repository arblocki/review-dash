import { describe, expect, it } from 'vitest';
import type { Hunk, ParsedFile } from '../types';
import {
  fileThreadOwners,
  sectionsForGroup,
  sectionsFromFilePaths,
  sectionsFromHunkIds,
} from './sections';

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

describe('sectionsFromFilePaths', () => {
  const files = [file('a', ['a1']), file('bin', []), file('ren', [])];

  it('makes hunkless sections in file order, skipping unknown paths', () => {
    const s = sectionsFromFilePaths(files, ['ren', 'nope', 'bin']);
    expect(s.map((x) => [x.file.path, x.hunks.length])).toEqual([
      ['bin', 0],
      ['ren', 0],
    ]);
  });

  it('sectionsForGroup lists hunk sections then file sections', () => {
    const s = sectionsForGroup(files, { hunkIds: ['a1'], files: ['bin', 'ren'] });
    expect(s.map((x) => [x.file.path, x.hunks.length])).toEqual([
      ['a', 1],
      ['bin', 0],
      ['ren', 0],
    ]);
  });
});

describe('fileThreadOwners', () => {
  const files = [file('a.ts', ['a1', 'a2']), file('b.ts', ['b1']), file('c.png', [])];
  const grp = (key: string, hunkIds: string[], paths: string[] = []) => ({
    key,
    hunkIds,
    files: paths,
  });

  it('gives a file split across two groups to exactly one of them (the first)', () => {
    const groups = [grp('g1', ['a1']), grp('g2', ['a2', 'b1'])];
    const owners = fileThreadOwners(groups, files);
    expect(owners.get('a.ts')).toBe('g1');
    // The thread is rendered by one group only.
    const rendering = groups.filter((g) => owners.get('a.ts') === g.key);
    expect(rendering).toHaveLength(1);
    expect(owners.get('b.ts')).toBe('g2');
  });

  it('follows display order, not the order of the analysis', () => {
    const groups = [grp('g2', ['a2']), grp('g1', ['a1'])];
    expect(fileThreadOwners(groups, files).get('a.ts')).toBe('g2');
  });

  it('counts hunkless files listed by a group, and skips files in no group', () => {
    const owners = fileThreadOwners([grp('g1', [], ['c.png'])], files);
    expect(owners.get('c.png')).toBe('g1');
    expect(owners.has('a.ts')).toBe(false);
  });
});
