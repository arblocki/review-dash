import type { PrSummary } from '../types';

/** Which page to show: one PR's review, or the repository's open-PR list. */
export type Route = { kind: 'pr'; number: number } | { kind: 'list' };

/**
 * Reads the route from the query string: `?pr=12` opens PR 12 and `?pulls` the list. With
 * neither, the PR the server was started with opens, else the list.
 */
export function routeFromSearch(search: string, initialPr: number | null): Route {
  const params = new URLSearchParams(search);
  const raw = params.get('pr');
  if (raw !== null && /^\d+$/.test(raw)) {
    const number = Number(raw);
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'pr', number };
  }
  if (params.has('pulls') || initialPr === null) return { kind: 'list' };
  return { kind: 'pr', number: initialPr };
}

export function prHref(number: number): string {
  return `?pr=${number}`;
}

export const LIST_HREF = '?pulls';

/**
 * Filters the open-PR list by free text. Every whitespace-separated term must match: a number
 * (`12` or `#12`) matches only that PR; other text matches the title, author, a branch or a
 * label, case-insensitively.
 */
export function filterPrs(prs: PrSummary[], query: string): PrSummary[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return prs;
  return prs.filter((p) => {
    const haystack = [p.title, p.author, p.headRef, p.baseRef, ...p.labels]
      .join('\n')
      .toLowerCase();
    return terms.every((t) => {
      const num = /^#?(\d+)$/.exec(t);
      return num ? String(p.number) === num[1] : haystack.includes(t);
    });
  });
}

/** "just now", "5m ago", "3h ago", "2d ago", or a date for anything older than 30 days. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
