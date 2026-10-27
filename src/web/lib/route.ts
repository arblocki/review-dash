import { parsePrRef, parseRepoRef } from '../../core/pr-ref';
import type { PrRef, PrSummary, RepoRef } from '../types';

/** Which page to show: the repository list, one repo's open PRs, or one PR's review. */
export type Route =
  { kind: 'repos' } | { kind: 'pulls'; repo: RepoRef } | { kind: 'pr'; pr: PrRef };

/**
 * Reads the route from the query string: `?repos` is the repository list, `?repo=o/r` that
 * repo's open PRs, and `?repo=o/r&pr=12` PR 12. With no query, the PR or repo the server was
 * started with opens, else the repository list. An invalid `repo` shows the repository list.
 */
export function routeFromSearch(
  search: string,
  start: { repo: RepoRef | null; pr: PrRef | null },
): Route {
  const params = new URLSearchParams(search);
  if (params.has('repos')) return { kind: 'repos' };
  const rawRepo = params.get('repo');
  if (rawRepo === null) {
    if (start.pr) return { kind: 'pr', pr: start.pr };
    return start.repo ? { kind: 'pulls', repo: start.repo } : { kind: 'repos' };
  }
  const repo = parseRepoRef(rawRepo);
  if (!repo) return { kind: 'repos' };
  const pr = parsePrRef(`${repo.owner}/${repo.repo}#${params.get('pr') ?? ''}`);
  return pr ? { kind: 'pr', pr } : { kind: 'pulls', repo };
}

// Owner and repo names are [A-Za-z0-9_.-], so they need no escaping.
export function pullsHref({ owner, repo }: RepoRef): string {
  return `?repo=${owner}/${repo}`;
}

export function prHref(repo: RepoRef, number: number): string {
  return `${pullsHref(repo)}&pr=${number}`;
}

export const REPOS_HREF = '?repos';

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
