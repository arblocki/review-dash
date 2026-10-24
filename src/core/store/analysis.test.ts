import { describe, expect, it } from 'vitest';
import type { Analysis } from '../group/types.js';
import { openStore } from './index.js';

const ref = { owner: 'o', repo: 'r', number: 1 };
const key = { headSha: 'h1', diffHash: 'd1', provider: 'p', model: 'm', promptVersion: 'v1' };
const analysis = (summary: string): Analysis => ({
  summary,
  groups: [],
  unrelatedOrSuspicious: [],
  fallback: false,
  backfilled: 0,
  mapReduce: false,
  provider: 'p',
  model: 'm',
  promptVersion: 'v1',
  durationMs: 1,
});

describe('analysis cache', () => {
  it('hits on the exact key and misses when any part differs', () => {
    const s = openStore(':memory:');
    expect(s.getAnalysis(ref, key)).toBeUndefined();
    s.saveAnalysis(ref, key, analysis('one'));
    expect(s.getAnalysis(ref, key)?.summary).toBe('one');
    for (const change of [
      { headSha: 'h2' },
      { diffHash: 'd2' },
      { provider: 'q' },
      { model: 'n' },
      { promptVersion: 'v2' },
    ]) {
      expect(s.getAnalysis(ref, { ...key, ...change })).toBeUndefined();
    }
    expect(s.getAnalysis({ ...ref, number: 2 }, key)).toBeUndefined();
    expect(s.getAnalysis({ ...ref, repo: 'x' }, key)).toBeUndefined();
  });

  it('replaces on save with the same key', () => {
    const s = openStore(':memory:');
    s.saveAnalysis(ref, key, analysis('one'));
    s.saveAnalysis(ref, key, analysis('two'));
    expect(s.getAnalysis(ref, key)?.summary).toBe('two');
  });
});
