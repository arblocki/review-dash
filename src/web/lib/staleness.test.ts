import { describe, expect, it } from 'vitest';
import { isStale, needsReanalysis, prVersionKey } from './staleness';

const pr = { headSha: 'aaa1111', diffHash: 'd1' };

describe('isStale', () => {
  it('is false for a matching analysis, no analysis, or a server without versions', () => {
    expect(isStale({ headSha: 'aaa1111', diffHash: 'd1' }, pr)).toBe(false);
    expect(isStale(null, pr)).toBe(false);
    expect(isStale({}, pr)).toBe(false);
  });

  it('is true when the head or the diff differs', () => {
    expect(isStale({ headSha: 'bbb2222', diffHash: 'd1' }, pr)).toBe(true);
    expect(isStale({ headSha: 'aaa1111', diffHash: 'd2' }, pr)).toBe(true);
  });
});

describe('needsReanalysis', () => {
  it('requests again only when the PR version moved since the last request', () => {
    expect(needsReanalysis(prVersionKey(pr), pr)).toBe(false);
    expect(needsReanalysis(prVersionKey({ ...pr, diffHash: 'd0' }), pr)).toBe(true);
    expect(needsReanalysis(null, pr)).toBe(false);
  });

  it('does not loop: once requested for this version it stays quiet even if the result failed', () => {
    const key = prVersionKey({ headSha: 'bbb2222', diffHash: 'd1' });
    expect(needsReanalysis(key, { headSha: 'bbb2222', diffHash: 'd1' })).toBe(false);
  });
});
