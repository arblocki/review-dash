import { describe, expect, it } from 'vitest';
import type { AnalysisGroup, Hunk } from '../types';
import {
  countKnownHunks,
  describeAnalysisError,
  formatDuration,
  groupByKey,
  hunkToGroup,
  orderGroups,
  pickGroup,
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
    expect(verifyId('k', 2)).toBe('k:2');
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
