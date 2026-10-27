import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import { recentRepos } from '../lib/recentRepos';
import { filterRepoEntries, orderRepos, repoKey } from '../lib/repoList';
import { pullsHref, relativeTime } from '../lib/route';
import type { RepoSummary } from '../types';
import { useListNav } from '../useListNav';
import { useLoader } from '../useLoader';
import { listClass, PickerShell, rowClass } from './PickerShell';

const badge =
  'shrink-0 rounded border border-gray-300 px-1.5 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-300';

/** Repositories the viewer can access; picking one lists its open pull requests. */
export function RepoPicker() {
  const fetcher = useCallback(
    () => api<{ repos: RepoSummary[] }>('/api/repos').then((r) => r.repos),
    [],
  );
  const { data: repos, error, loading, reload } = useLoader(fetcher);
  const [recent] = useState(() => recentRepos());
  const [query, setQuery] = useState('');

  const ordered = useMemo(() => orderRepos(repos ?? [], recent), [repos, recent]);
  const entries = useMemo(() => filterRepoEntries(ordered, query), [ordered, query]);

  const { current, setActive, listRef, onKeyDown } = useListNav(entries.length, (i) => {
    const pick = i === null ? undefined : entries[i];
    if (pick) location.search = pullsHref(pick.repo);
  });

  return (
    <PickerShell
      title="Repositories"
      loading={loading}
      onRefresh={() => void reload()}
      query={query}
      onQuery={(q) => {
        setQuery(q);
        setActive(0);
      }}
      onKeyDown={onKeyDown}
      placeholder="Filter, or type any owner/repo or GitHub URL — ↑/↓ to move, Enter to open"
      filterLabel="Filter repositories"
      error={error && `Could not list your repositories: ${error}`}
    >
      {repos === null && !error && (
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">Loading repositories…</p>
      )}

      {repos !== null && entries.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {repos.length === 0 && recent.length === 0
            ? 'No repositories found. Type owner/repo to open one.'
            : 'No repositories match. Type owner/repo to open any repository.'}
        </p>
      )}

      {entries.length > 0 && (
        <ul ref={listRef} className={listClass} aria-label="Repositories">
          {entries.map((e, i) => {
            const s = e.summary;
            return (
              <li key={`${e.typed ? 'typed:' : ''}${repoKey(e.repo)}`} data-index={i}>
                <a
                  href={pullsHref(e.repo)}
                  aria-current={i === current ? 'true' : undefined}
                  onMouseEnter={() => setActive(i)}
                  className={rowClass(i === current)}
                >
                  <div className="flex items-baseline gap-2">
                    {e.typed && (
                      <span className="shrink-0 text-sm text-gray-500 dark:text-gray-400">
                        Open
                      </span>
                    )}
                    <span className="min-w-0 truncate font-mono text-sm font-medium">
                      {e.repo.owner}/{e.repo.repo}
                    </span>
                    {e.recent && <span className={badge}>Recent</span>}
                    {s?.private && <span className={badge}>Private</span>}
                    {s?.fork && <span className={badge}>Fork</span>}
                    {s?.archived && <span className={badge}>Archived</span>}
                    <span className="flex-1" />
                    {s?.pushedAt && (
                      <span
                        className="shrink-0 text-xs text-gray-500 dark:text-gray-400"
                        title={s.pushedAt}
                      >
                        pushed {relativeTime(s.pushedAt)}
                      </span>
                    )}
                  </div>
                  {s?.description && (
                    <div
                      className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400"
                      title={s.description}
                    >
                      {s.description}
                    </div>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {repos !== null && repos.length >= 500 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Showing your 500 most recently pushed repositories. Type owner/repo to open any other.
        </p>
      )}
    </PickerShell>
  );
}
