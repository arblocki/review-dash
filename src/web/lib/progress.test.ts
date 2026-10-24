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
    const auto = autoClearIds(groups);
    const status = (id: string) => hunkStatus(id, new Set(['x1']), auto, new Set(['m2']));
    const p = groupProgress(groups, known, status);
    expect(p.get('m')).toMatchObject({ total: 2, auto: 1, done: 1, complete: false });
    expect(p.get('x')).toMatchObject({ total: 2, reviewed: 1, done: 1 });
    expect(p.get('u')?.done).toBe(0);
  });
});
