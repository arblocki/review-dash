import { describe, expect, it } from 'vitest';
import type { Hunk, ParsedFile } from '../types';
import { filterSections } from './reviewFilter';
import { allItemIds, fileItemId, fileKeyMap, groupItemIds, itemsLabel } from './reviewItems';
import { sectionsFromFilePaths } from './sections';

const file = (path: string, hunks: string[] = [], blobSha?: string): ParsedFile =>
  ({
    path,
    status: 'modified',
    hunks: hunks.map((id) => ({ id }) as Hunk),
    ...(blobSha ? { blobSha } : {}),
  }) as ParsedFile;

const files = [file('a.ts', ['h1', 'h2']), file('img.png', [], 'sha-img'), file('mv.ts')];

describe('fileItemId', () => {
  it('uses the blob sha, falling back to the head sha', () => {
    expect(fileItemId(file('img.png', [], 'sha-img'), 'head1')).toBe('file:img.png@sha-img');
    expect(fileItemId(file('mv.ts'), 'head1')).toBe('file:mv.ts@head1');
  });
  it('changes when the blob sha changes, and (without one) when the head changes', () => {
    expect(fileItemId(file('x', [], 'a'), 'h')).not.toBe(fileItemId(file('x', [], 'b'), 'h'));
    expect(fileItemId(file('x'), 'h1')).not.toBe(fileItemId(file('x'), 'h2'));
    expect(fileItemId(file('x', [], 'a'), 'h1')).toBe(fileItemId(file('x', [], 'a'), 'h2'));
  });
});

describe('review item ids', () => {
  const keys = fileKeyMap(files, 'head1');
  const known = allItemIds(files, 'head1');
  it('only hunkless files get keys', () => {
    expect([...keys.keys()]).toEqual(['img.png', 'mv.ts']);
    expect([...known].sort()).toEqual(['file:img.png@sha-img', 'file:mv.ts@head1', 'h1', 'h2']);
  });
  it('lists hunk ids then file keys for a group, dropping unknown ones', () => {
    const group = { hunkIds: ['h2', 'gone'], files: ['img.png', 'mv.ts', 'nope.bin'] };
    expect(groupItemIds(group, keys, known)).toEqual([
      'h2',
      'file:img.png@sha-img',
      'file:mv.ts@head1',
    ]);
  });
});

describe('hide-reviewed with hunkless files', () => {
  const sections = sectionsFromFilePaths(files, ['img.png', 'mv.ts']);
  it('keeps unreviewed file sections and hides reviewed ones', () => {
    expect(filterSections(sections, () => true)).toHaveLength(2);
    const out = filterSections(
      sections,
      () => true,
      (p) => p === 'img.png',
    );
    expect(out.map((s) => s.file.path)).toEqual(['mv.ts']);
  });
});

describe('itemsLabel', () => {
  it('names what the group holds', () => {
    expect(itemsLabel(1, true, false)).toBe('hunk');
    expect(itemsLabel(3, true, false)).toBe('hunks');
    expect(itemsLabel(2, false, true)).toBe('files');
    expect(itemsLabel(3, true, true)).toBe('hunks + files');
  });
});
