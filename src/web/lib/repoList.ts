import { parseRepoRef } from '../../core/pr-ref';
import type { RepoRef, RepoSummary } from '../types';

export interface RepoEntry {
  repo: RepoRef;
  /** Missing for a recent or typed repo the GitHub listing does not include. */
  summary?: RepoSummary;
  recent?: boolean;
  /** The filter text itself, parsed as `owner/repo` or a repository URL. */
  typed?: boolean;
}

export const repoKey = (r: RepoRef): string => `${r.owner}/${r.repo}`.toLowerCase();

/**
 * Recently opened repos first, then the rest of the viewer's repos (latest push first, archived
 * last). Recent repos the listing lacks (e.g. public repos typed in) are kept without details.
 */
export function orderRepos(listed: RepoSummary[], recent: RepoRef[]): RepoEntry[] {
  const toRef = (s: RepoSummary): RepoRef => ({ owner: s.owner, repo: s.name });
  const byKey = new Map(listed.map((s) => [repoKey(toRef(s)), s]));
  const recentKeys = new Set(recent.map(repoKey));
  const rest = listed
    .filter((s) => !recentKeys.has(repoKey(toRef(s))))
    .sort((a, b) => Number(a.archived) - Number(b.archived));
  return [
    ...recent.map((repo) => ({ repo, summary: byKey.get(repoKey(repo)), recent: true })),
    ...rest.map((summary) => ({ repo: toRef(summary), summary })),
  ];
}

/**
 * Keeps entries where every whitespace-separated term appears in `owner/repo` or the
 * description (case-insensitive). If the query is itself an `owner/repo` or repository URL not
 * already listed, it comes first as a `typed` entry, so any repository can be opened.
 */
export function filterRepoEntries(entries: RepoEntry[], query: string): RepoEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = entries.filter((e) => {
    const haystack = `${repoKey(e.repo)}\n${e.summary?.description ?? ''}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
  const typed = parseRepoRef(query);
  if (typed && !kept.some((e) => repoKey(e.repo) === repoKey(typed))) {
    kept.unshift({ repo: typed, typed: true });
  }
  return kept;
}
