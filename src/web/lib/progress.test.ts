import { describe, expect, it } from 'vitest';
import type { AnalysisGroup } from '../types';
import { autoClearIds, groupProgress, hunkStatus, progressFor } from './progress';

const g = (key: string, hunkIds: string[], extra: Partial<AnalysisGroup> = {}): AnalysisGroup => ({
  key,
  title: key,
  intent: '',
  kind: 'feature',
  risk: 'low',
  riskReasons: [],
  verify: [],
  files: [],
  hunkIds,
  files: [],
  dependsOn: [],
  autoClear: false,
  ...extra,
});

describe('hunkStatus', () => {
  const reviewed = new Set(['a']);
  const auto = new Set(['a', 'b', 'c']);
  const unchecked = new Set(['c']);
  it('prefers manual review, then auto-clear unless unchecked', () => {
    expect(hunkStatus('a', reviewed, auto, unchecked)).toBe('reviewed');
    expect(hunkStatus('b', reviewed, auto, unchecked)).toBe('auto');
    expect(hunkStatus('c', reviewed, auto, unchecked)).toBe('none');
    expect(hunkStatus('d', reviewed, auto, unchecked)).toBe('none');
  });
});

describe('progressFor', () => {
  it('counts reviewed and auto-cleared separately', () => {
    const p = progressFor(['a', 'b', 'c', 'd'], (id) =>
      id === 'a' ? 'reviewed' : id === 'b' ? 'auto' : 'none',
    );
    expect(p).toMatchObject({ total: 4, reviewed: 1, auto: 1, done: 2, pct: 50, complete: false });
  });
  it('is complete at 100% and for an empty list; floors partial percentages', () => {
    expect(progressFor(['a'], () => 'auto').complete).toBe(true);
    expect(progressFor([], () => 'none')).toMatchObject({ total: 0, pct: 100, complete: true });
    expect(progressFor(['a', 'b', 'c'], (id) => (id === 'c' ? 'none' : 'reviewed')).pct).toBe(66);
  });
  it('ignores duplicate ids', () => {
    expect(progressFor(['a', 'a'], () => 'none').total).toBe(1);
  });
});

describe('autoClearIds / groupProgress', () => {
  const groups = [
    g('m', ['m1', 'm2'], { autoClear: true }),
    g('u', ['u1'], { autoClear: true, unclassified: true }),
    g('x', ['x1', 'x2', 'stale']),
  ];
  it('collects auto-clear hunks but never unclassified ones', () => {
    expect([...autoClearIds(groups)].sort()).toEqual(['m1', 'm2']);
  });
  it('computes per-group progress over known hunks only', () => {
    const known = new Set(['m1', 'm2', 'u1', 'x1', 'x2']);
    const noKeys = new Map<string, string>();
    const auto = autoClearIds(groups);
    const status = (id: string) => hunkStatus(id, new Set(['x1']), auto, new Set(['m2']));
    const p = groupProgress(groups, noKeys, known, status);
    expect(p.get('m')).toMatchObject({ total: 2, auto: 1, done: 1, complete: false });
    expect(p.get('x')).toMatchObject({ total: 2, reviewed: 1, done: 1 });
    expect(p.get('u')?.done).toBe(0);
  });
});

describe('file review items', () => {
  const fileKeys = new Map([
    ['old.png', 'file:old.png@b1'],
    ['big.json', 'file:big.json@b2'],
    ['mv.ts', 'file:mv.ts@b3'],
  ]);
  const groups = [
    g('mech', ['m1'], { autoClear: true, files: ['mv.ts'] }),
    g('nodiff', [], {
      title: 'Files without a diff — review on GitHub',
      files: ['old.png', 'big.json'],
    }),
    g('flagged', ['f1'], { files: [] }),
  ];
  const known = new Set(['m1', 'f1', ...fileKeys.values()]);

  it('auto-clears file items only in autoClear groups', () => {
    expect([...autoClearIds(groups, fileKeys)].sort()).toEqual(['file:mv.ts@b3', 'm1']);
  });

  it('a files-without-diff group is incomplete until every file is marked', () => {
    const auto = autoClearIds(groups, fileKeys);
    const statusFor = (reviewed: string[]) => (id: string) =>
      hunkStatus(id, new Set(reviewed), auto, new Set());
    let p = groupProgress(groups, fileKeys, known, statusFor([])).get('nodiff')!;
    expect(p).toMatchObject({ total: 2, done: 0, complete: false });
    p = groupProgress(groups, fileKeys, known, statusFor(['file:old.png@b1'])).get('nodiff')!;
    expect(p).toMatchObject({ done: 1, complete: false });
    p = groupProgress(
      groups,
      fileKeys,
      known,
      statusFor(['file:old.png@b1', 'file:big.json@b2']),
    ).get('nodiff')!;
    expect(p).toMatchObject({ done: 2, complete: true });
  });

  it('counts hunks and auto-cleared renames together in a mechanical group', () => {
    const auto = autoClearIds(groups, fileKeys);
    const p = groupProgress(groups, fileKeys, known, (id) =>
      hunkStatus(id, new Set(), auto, new Set()),
    ).get('mech')!;
    expect(p).toMatchObject({ total: 2, auto: 2, complete: true });
  });

  it('ignores file keys that are not in the PR', () => {
    const p = groupProgress(groups, fileKeys, new Set(['file:old.png@b1']), () => 'none');
    expect(p.get('nodiff')?.total).toBe(1);
  });
});
