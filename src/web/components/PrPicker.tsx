import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { filterPrs, prHref, relativeTime } from '../lib/route';
import type { AppSession, PrSummary } from '../types';

const btn =
  'rounded border border-gray-300 bg-white px-2.5 py-1 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800';

/** The repository's open pull requests; picking one opens its review. */
export function PrPicker({ session }: { session: AppSession }) {
  const [pulls, setPulls] = useState<PrSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const repoLabel = `${session.repo.owner}/${session.repo.repo}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPulls((await api<{ pulls: PrSummary[] }>('/api/pulls')).pulls);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => filterPrs(pulls ?? [], query), [pulls, query]);
  const current = Math.min(active, Math.max(shown.length - 1, 0));
  // A number that matches nothing open (e.g. a closed PR) can still be opened directly.
  const typedNumber = /^\s*#?(\d+)\s*$/.exec(query)?.[1];

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(current + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (e.key === 'Enter') {
      const pick = shown[current];
      if (pick) location.search = prHref(pick.number);
      else if (typedNumber) location.search = prHref(Number(typedNumber));
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold">Open pull requests</h1>
        <a
          href={`https://github.com/${repoLabel}/pulls`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm text-gray-500 hover:underline dark:text-gray-400"
        >
          {repoLabel} ↗
        </a>
        <span className="flex-1" />
        <button type="button" className={btn} disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <input
        type="search"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Filter by number, title, author, branch or label — ↑/↓ to move, Enter to open"
        aria-label="Filter pull requests"
        className="mb-3 w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />

      {error && (
        <p
          role="alert"
          className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          Could not list pull requests: {error}
        </p>
      )}

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
                href={prHref(Number(typedNumber))}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                Open #{typedNumber} anyway
              </a>
            </>
          )}
        </p>
      )}

      {shown.length > 0 && (
        <ul
          ref={listRef}
          className="divide-y divide-gray-200 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-800"
          aria-label="Open pull requests"
        >
          {shown.map((p, i) => (
            <li key={p.number} data-index={i}>
              <a
                href={prHref(p.number)}
                aria-current={i === current ? 'true' : undefined}
                onMouseEnter={() => setActive(i)}
                className={`block px-3 py-2 ${
                  i === current
                    ? 'bg-blue-50 dark:bg-blue-950/50'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-900'
                }`}
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
    </div>
  );
}
