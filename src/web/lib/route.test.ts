import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../types';
import { filterPrs, prHref, pullsHref, relativeTime, routeFromSearch } from './route';

describe('routeFromSearch', () => {
  const repo = { owner: 'octocat', repo: 'hello-world' };
  const none = { repo: null, pr: null };
  const startPr = { repo, pr: { ...repo, number: 3 } };

  it('opens ?repo=o/r&pr=N', () => {
    expect(routeFromSearch('?repo=a/b&pr=12', startPr)).toEqual({
      kind: 'pr',
      pr: { owner: 'a', repo: 'b', number: 12 },
    });
  });

  it('lists the PRs of ?repo=o/r', () => {
    expect(routeFromSearch('?repo=a/b', startPr)).toEqual({
      kind: 'pulls',
      repo: { owner: 'a', repo: 'b' },
    });
  });

  it('shows the repository list for ?repos, whatever the server started with', () => {
    expect(routeFromSearch('?repos', startPr)).toEqual({ kind: 'repos' });
  });

  it('falls back to the starting PR, then repo, then the repository list', () => {
    expect(routeFromSearch('', startPr)).toEqual({ kind: 'pr', pr: startPr.pr });
    expect(routeFromSearch('', { repo, pr: null })).toEqual({ kind: 'pulls', repo });
    expect(routeFromSearch('', none)).toEqual({ kind: 'repos' });
  });

  it.each(['?repo=nope', '?repo=a/b/c', '?repo='])('shows the repository list for %s', (q) => {
    expect(routeFromSearch(q, startPr)).toEqual({ kind: 'repos' });
  });

  it.each(['?pr=0', '?pr=abc', '?pr=-1', '?pr=1.5', '?pr='])('treats &%s as no PR', (pr) => {
    expect(routeFromSearch(`?repo=a/b&${pr.slice(1)}`, none)).toEqual({
      kind: 'pulls',
      repo: { owner: 'a', repo: 'b' },
    });
  });

  it('builds hrefs that round-trip', () => {
    expect(routeFromSearch(pullsHref(repo), none)).toEqual({ kind: 'pulls', repo });
    expect(routeFromSearch(prHref(repo, 9), none)).toEqual({
      kind: 'pr',
      pr: { ...repo, number: 9 },
    });
  });
});

const pr = (number: number, extra: Partial<PrSummary> = {}): PrSummary => ({
  number,
  title: `PR ${number}`,
  author: 'octocat',
  draft: false,
  url: '',
  headRef: `branch-${number}`,
  baseRef: 'main',
  createdAt: '',
  updatedAt: '',
  labels: [],
  requestedReviewers: [],
  ...extra,
});

describe('filterPrs', () => {
  const prs = [
    pr(1, { title: 'Add webhook retries', labels: ['backend'] }),
    pr(12, { title: 'Fix login page', author: 'Hubot' }),
    pr(123, { headRef: 'retry-ui' }),
  ];
  const numbers = (q: string) => filterPrs(prs, q).map((p) => p.number);

  it('returns everything for an empty query', () => {
    expect(numbers('  ')).toEqual([1, 12, 123]);
  });

  it('matches a number exactly, with or without #', () => {
    expect(numbers('12')).toEqual([12]);
    expect(numbers('#1')).toEqual([1]);
  });

  it('matches title, author, branch and label case-insensitively', () => {
    expect(numbers('WEBHOOK')).toEqual([1]);
    expect(numbers('hubot')).toEqual([12]);
    expect(numbers('retr')).toEqual([1, 123]);
    expect(numbers('backend')).toEqual([1]);
  });

  it('requires every term to match', () => {
    expect(numbers('retr ui')).toEqual([123]);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  it.each([
    ['2026-03-10T11:59:40Z', 'just now'],
    ['2026-03-10T11:55:00Z', '5m ago'],
    ['2026-03-10T09:00:00Z', '3h ago'],
    ['2026-03-08T12:00:00Z', '2d ago'],
    ['2026-01-01T00:00:00Z', '2026-01-01'],
    ['bogus', ''],
  ])('%s → %j', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});
