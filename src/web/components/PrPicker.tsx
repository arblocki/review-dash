import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, repoUrl } from '../api';
import { rememberRepo } from '../lib/recentRepos';
import { filterPrs, prHref, relativeTime, REPOS_HREF } from '../lib/route';
import type { PrSummary, RepoRef } from '../types';
import { useListNav } from '../useListNav';
import { useLoader } from '../useLoader';
import { listClass, PickerShell, rowClass } from './PickerShell';

/** The repository's open pull requests; picking one opens its review. */
export function PrPicker({ repo }: { repo: RepoRef }) {
  const fetcher = useCallback(
    () => api<{ pulls: PrSummary[] }>(repoUrl(repo, '/pulls')).then((r) => r.pulls),
    [repo],
  );
  const { data: pulls, error, loading, reload } = useLoader(fetcher);
  const [query, setQuery] = useState('');
  const repoLabel = `${repo.owner}/${repo.repo}`;

  // Only repos that actually load go on the recent list.
  useEffect(() => {
    if (pulls) rememberRepo(repo);
  }, [pulls, repo]);

  const shown = useMemo(() => filterPrs(pulls ?? [], query), [pulls, query]);
  // A number that matches nothing open (e.g. a closed PR) can still be opened directly.
  const typedNumber = /^\s*#?(\d+)\s*$/.exec(query)?.[1];
  const { current, setActive, listRef, onKeyDown } = useListNav(shown.length, (i) => {
    const pick = i === null ? undefined : shown[i];
    if (pick) location.search = prHref(repo, pick.number);
    else if (typedNumber) location.search = prHref(repo, Number(typedNumber));
  });

  return (
    <PickerShell
      title="Open pull requests"
      back={
        <a href={REPOS_HREF} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          ← Repos
        </a>
      }
      subtitle={
        <a
          href={`https://github.com/${repoLabel}/pulls`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm text-gray-500 hover:underline dark:text-gray-400"
        >
          {repoLabel} ↗
        </a>
      }
      loading={loading}
      onRefresh={() => void reload()}
      query={query}
      onQuery={(q) => {
        setQuery(q);
        setActive(0);
      }}
      onKeyDown={onKeyDown}
      placeholder="Filter by number, title, author, branch or label — ↑/↓ to move, Enter to open"
      filterLabel="Filter pull requests"
      error={error && `Could not list pull requests: ${error}`}
    >
      {pulls === null && !error && (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading pull requests…</p>
      )}

      {pulls !== null && shown.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {pulls.length === 0 ? 'No open pull requests.' : 'No open pull requests match.'}
          {typedNumber && (
            <>
              {' '}
              <a
                href={prHref(repo, Number(typedNumber))}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                Open #{typedNumber} anyway
              </a>
            </>
          )}
        </p>
      )}

      {shown.length > 0 && (
        <ul ref={listRef} className={listClass} aria-label="Open pull requests">
          {shown.map((p, i) => (
            <li key={p.number} data-index={i}>
              <a
                href={prHref(repo, p.number)}
                aria-current={i === current ? 'true' : undefined}
                onMouseEnter={() => setActive(i)}
                className={rowClass(i === current)}
              >
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-sm text-gray-500 dark:text-gray-400">
                    #{p.number}
                  </span>
                  <span className="min-w-0 truncate font-medium" title={p.title}>
                    {p.title}
                  </span>
                  {p.draft && (
                    <span className="shrink-0 rounded border border-gray-300 px-1.5 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-300">
                      Draft
                    </span>
                  )}
                  {p.labels.map((l) => (
                    <span
                      key={l}
                      className="shrink-0 rounded-full bg-gray-100 px-2 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                    >
                      {l}
                    </span>
                  ))}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-gray-500 dark:text-gray-400">
                  <span>{p.author}</span>
                  <span className="font-mono">
                    {p.headRef} → {p.baseRef}
                  </span>
                  <span title={p.updatedAt}>updated {relativeTime(p.updatedAt)}</span>
                  {p.requestedReviewers.length > 0 && (
                    <span>review requested: {p.requestedReviewers.join(', ')}</span>
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
      {pulls !== null && pulls.length >= 500 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Showing the 500 most recently updated open pull requests.
        </p>
      )}
    </PickerShell>
  );
}
