import { describe, expect, it } from 'vitest';
import type { AnalysisGroup, Hunk } from '../types';
import {
  countKnownHunks,
  describeAnalysisError,
  formatDuration,
  groupNeighbors,
  hash8,
  groupOptionLabel,
  groupByKey,
  hunkToGroup,
  isFilesWithoutDiff,
  itemCounts,
  orderGroups,
  pickGroup,
  railCount,
  resolveView,
  riskBadge,
  usageParts,
  verifyId,
} from './groups';

const g = (key: string, extra: Partial<AnalysisGroup> = {}): AnalysisGroup => ({
  key,
  title: key,
  intent: '',
  kind: 'feature',
  risk: 'medium',
  riskReasons: [],
  verify: [],
  hunkIds: [],
  files: [],
  dependsOn: [],
  autoClear: false,
  ...extra,
});

describe('orderGroups', () => {
  const groups = [g('a'), g('t1', { kind: 'test' }), g('b'), g('t2', { kind: 'test' })];
  it('keeps analysis order for "group" and "file"', () => {
    expect(orderGroups(groups, 'group').map((x) => x.key)).toEqual(['a', 't1', 'b', 't2']);
    expect(orderGroups(groups, 'file')).toBe(groups);
  });
  it('puts test groups first, stable, for "tests"', () => {
    expect(orderGroups(groups, 'tests').map((x) => x.key)).toEqual(['t1', 't2', 'a', 'b']);
    expect(groups.map((x) => x.key)).toEqual(['a', 't1', 'b', 't2']);
  });
});

describe('riskBadge', () => {
  it('maps risk levels', () => {
    expect(riskBadge(g('x', { risk: 'high' }))).toEqual({ label: 'HIGH', tone: 'high' });
    expect(riskBadge(g('x', { risk: 'medium' }))).toEqual({ label: 'MED', tone: 'medium' });
    expect(riskBadge(g('x', { risk: 'low' }))).toEqual({ label: 'LOW', tone: 'low' });
  });
  it('shows AUTO for auto-clear and !! for unclassified (which wins)', () => {
    expect(riskBadge(g('x', { risk: 'low', autoClear: true })).label).toBe('AUTO');
    expect(riskBadge(g('x', { risk: 'high', unclassified: true, autoClear: true })).tone).toBe(
      'unclassified',
    );
  });
});

describe('riskBadge for mechanical groups', () => {
  it('uses the risk, not the kind, unless the group is auto-cleared', () => {
    expect(riskBadge(g('x', { kind: 'mechanical', risk: 'high' }))).toEqual({
      label: 'HIGH',
      tone: 'high',
    });
    expect(riskBadge(g('x', { kind: 'mechanical', risk: 'medium' })).tone).toBe('medium');
    expect(riskBadge(g('x', { kind: 'mechanical', risk: 'low', autoClear: true })).tone).toBe(
      'auto',
    );
  });
});

describe('itemCounts', () => {
  it('shows hunks, files, or both', () => {
    expect(itemCounts(g('x', { hunkIds: ['a'] }))).toBe('1 hunk');
    expect(itemCounts(g('x', { hunkIds: ['a', 'b', 'c'], files: ['p', 'q'] }))).toBe(
      '3 hunks · 2 files',
    );
    expect(itemCounts(g('x', { files: ['p'] }))).toBe('1 file');
    expect(itemCounts(g('x'))).toBe('0 hunks');
  });
  it('detects the files-without-diff group', () => {
    expect(isFilesWithoutDiff({ title: 'Files without a diff — review on GitHub' })).toBe(true);
    expect(isFilesWithoutDiff({ title: 'Mechanical changes' })).toBe(false);
  });
});

describe('selectors', () => {
  const groups = [g('a', { hunkIds: ['h1', 'h2'] }), g('b', { hunkIds: ['h3', 'h1'] })];
  it('looks groups up by key', () => {
    expect(groupByKey(groups).get('b')?.key).toBe('b');
    expect(groupByKey(groups).get('zz')).toBeUndefined();
  });
  it('maps hunks to their first group', () => {
    const m = hunkToGroup(groups);
    expect(m.get('h1')).toBe('a');
    expect(m.get('h3')).toBe('b');
  });
  it('picks the selected group or falls back to the first', () => {
    expect(pickGroup(groups, 'b')?.key).toBe('b');
    expect(pickGroup(groups, 'gone')?.key).toBe('a');
    expect(pickGroup(groups, null)?.key).toBe('a');
    expect(pickGroup([], null)).toBeUndefined();
  });
  it('builds verify ids and counts known hunks', () => {
    expect(verifyId('k', 2, 'check it')).toMatch(/^k:2:[0-9a-f]{8}$/);
    const hunks = [{ id: 'h1' }, { id: 'h2' }] as Hunk[];
    expect(countKnownHunks(groups[0]!, hunks)).toBe(2);
    expect(countKnownHunks(groups[1]!, hunks)).toBe(1);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(8300)).toBe('8.3s');
    expect(formatDuration(42_000)).toBe('42s');
  });
  it('formats usage, tolerating missing fields', () => {
    expect(
      usageParts({
        usage: { inputTokens: 12_345, outputTokens: 1200, costUsd: 0.0412 },
        durationMs: 8300,
      }),
    ).toEqual(['12k in / 1.2k out tokens', '$0.041', '8.3s']);
    expect(usageParts({ durationMs: 500 })).toEqual(['500ms']);
  });
  it('describes provider errors with a hint', () => {
    expect(describeAnalysisError('not_installed', 'x').hint).toMatch(/claude CLI/);
    expect(describeAnalysisError('unsupported', 'x').hint).toMatch(/Upgrade/);
    expect(describeAnalysisError('auth', 'x').title).toMatch(/signed in/);
    expect(describeAnalysisError('weird', 'x').title).toBe('Analysis failed');
  });
});

describe('resolveView', () => {
  it('defaults to By group once an analysis exists, else By file', () => {
    expect(resolveView(null, true, false)).toBe('group');
    expect(resolveView(null, false, false)).toBe('file');
    expect(resolveView('tests', true, false)).toBe('tests');
  });

  it('forces By file while the analysis is stale, whatever the choice', () => {
    expect(resolveView(null, true, true)).toBe('file');
    expect(resolveView('group', true, true)).toBe('file');
  });
});

describe('groupNeighbors', () => {
  const groups = [g('a'), g('b'), g('c')];
  it('gives prev/next and the position in display order', () => {
    expect(groupNeighbors(groups, 'a')).toEqual({
      prev: undefined,
      next: 'b',
      position: 1,
      total: 3,
    });
    expect(groupNeighbors(groups, 'b')).toMatchObject({ prev: 'a', next: 'c', position: 2 });
    expect(groupNeighbors(groups, 'c')).toMatchObject({ prev: 'b', next: undefined, position: 3 });
  });

  it('has no neighbours for an unknown key', () => {
    expect(groupNeighbors(groups, 'x')).toMatchObject({ prev: undefined, next: undefined });
  });
});

describe('railCount / groupOptionLabel', () => {
  it('formats hunk and file counts compactly', () => {
    expect(railCount(g('a', { hunkIds: ['1', '2', '3'] }))).toBe('3');
    expect(railCount(g('a', { hunkIds: ['1'], files: ['x'] }))).toBe('1 · 1f');
    expect(railCount(g('a', { files: ['x', 'y'] }))).toBe('2f');
  });

  it('puts the risk badge, title and count in one line', () => {
    expect(groupOptionLabel(g('a', { title: 'Auth', risk: 'high', hunkIds: ['1', '2'] }))).toBe(
      'HIGH · Auth (2)',
    );
  });
});

describe('verifyId', () => {
  it('is the same for the same group, index and text', () => {
    expect(verifyId('k', 0, 'check a')).toBe(verifyId('k', 0, 'check a'));
  });

  it('differs when the text at the same index changes', () => {
    expect(verifyId('k', 0, 'check a')).not.toBe(verifyId('k', 0, 'check b'));
  });

  it('differs by index and group for the same text', () => {
    expect(verifyId('k', 0, 'x')).not.toBe(verifyId('k', 1, 'x'));
    expect(verifyId('k', 0, 'x')).not.toBe(verifyId('j', 0, 'x'));
  });

  it('uses FNV-1a (known vectors)', () => {
    expect(hash8('')).toBe('811c9dc5');
    expect(hash8('a')).toBe('e40c292c');
  });
});
