import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../types';
import { filterPrs, relativeTime, routeFromSearch } from './route';

describe('routeFromSearch', () => {
  it('opens ?pr=N', () => {
    expect(routeFromSearch('?pr=12', 1)).toEqual({ kind: 'pr', number: 12 });
    expect(routeFromSearch('?pr=12', null)).toEqual({ kind: 'pr', number: 12 });
  });

  it('shows the list for ?pulls even with an initial PR', () => {
    expect(routeFromSearch('?pulls', 1)).toEqual({ kind: 'list' });
  });

  it('falls back to the initial PR, else the list', () => {
    expect(routeFromSearch('', 3)).toEqual({ kind: 'pr', number: 3 });
    expect(routeFromSearch('', null)).toEqual({ kind: 'list' });
  });

  it.each(['?pr=0', '?pr=abc', '?pr=-1', '?pr=1.5', '?pr='])('ignores %s', (search) => {
    expect(routeFromSearch(search, null)).toEqual({ kind: 'list' });
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
