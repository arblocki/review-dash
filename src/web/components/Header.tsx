import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pullsHref } from '../lib/route';
import { useDraftCount, useReview } from '../state';

const btn =
  'rounded border border-gray-300 bg-white px-2.5 py-1 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800';

export function Header({ onSubmit, extra }: { onSubmit: () => void; extra?: ReactNode }) {
  const {
    session,
    pr,
    incomplete,
    refreshing,
    refresh,
    refreshError,
    dismissRefreshError,
    viewType,
    setViewType,
    hideWhitespace,
    setHideWhitespace,
    flushDrafts,
  } = useReview();
  const [leaving, setLeaving] = useState(false);
  const draftCount = useDraftCount();
  const ref = useRef<HTMLDivElement>(null);

  // The sticky rail and scroll offsets key off the header's real height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () =>
      document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref}>
      {incomplete && (
        <div
          role="alert"
          data-testid="incomplete-banner"
          className="border-b border-red-300 bg-red-100 px-4 py-2 text-sm font-medium text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          GitHub only returned {incomplete.fetchedFiles} of {incomplete.changedFiles} changed files.
          This view is incomplete — review the rest on GitHub.{' '}
          <a
            href={`${pr.url}/files`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:no-underline"
          >
            Open the files tab ↗
          </a>
        </div>
      )}
      {refreshError !== null && (
        <div
          role="alert"
          data-testid="refresh-error"
          className="flex items-center gap-2 border-b border-red-300 bg-red-50 px-4 py-1.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <span className="min-w-0 flex-1">
            Refresh failed, showing the previous data: {refreshError}
          </span>
          <button
            type="button"
            className="shrink-0 rounded px-1.5 hover:bg-red-100 dark:hover:bg-red-900"
            aria-label="Dismiss"
            onClick={dismissRefreshError}
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <a
              href={pullsHref(session.pr)}
              className="shrink-0 text-sm text-blue-600 hover:underline dark:text-blue-400"
              title="All open pull requests"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                // Save pending drafts before the page goes away.
                e.preventDefault();
                if (leaving) return;
                setLeaving(true);
                void flushDrafts()
                  .then((unsynced) => {
                    const ok =
                      unsynced.length === 0 ||
                      confirm(
                        `${unsynced.length} draft comment(s) could not be saved and will be lost. Leave anyway?`,
                      );
                    if (ok) location.search = pullsHref(session.pr);
                  })
                  .finally(() => setLeaving(false));
              }}
            >
              ← PRs
            </a>
            <span className="shrink-0 font-mono text-sm text-gray-500 dark:text-gray-400">
              {session.pr.owner}/{session.pr.repo} #{session.pr.number}
            </span>
            <h1 className="truncate text-base font-semibold" title={pr.title}>
              {pr.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 text-xs text-gray-500 dark:text-gray-400">
            <span>
              <span className="text-green-700 dark:text-green-400">+{pr.additions}</span>{' '}
              <span className="text-red-700 dark:text-red-400">−{pr.deletions}</span>
            </span>
            <span>
              {incomplete
                ? `${incomplete.fetchedFiles} of ${incomplete.changedFiles} files`
                : `${pr.changedFiles} files`}
            </span>
            <span>
              head <code className="font-mono">{pr.headSha.slice(0, 7)}</code>
            </span>
            <span>
              {pr.headRef} → {pr.baseRef}
            </span>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              View on GitHub ↗
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={hideWhitespace}
              onChange={(e) => setHideWhitespace(e.target.checked)}
            />
            Hide whitespace
          </label>
          <div className="flex overflow-hidden rounded border border-gray-300 text-sm dark:border-gray-700">
            {(['unified', 'split'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={viewType === v}
                className={`px-2.5 py-1 capitalize ${
                  viewType === v
                    ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                    : 'bg-white hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800'
                }`}
                onClick={() => setViewType(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={btn}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
            onClick={onSubmit}
          >
            Submit review ({draftCount} {draftCount === 1 ? 'draft' : 'drafts'})
          </button>
        </div>
      </div>
      {extra}
    </div>
  );
}
