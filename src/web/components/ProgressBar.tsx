import { useMemo } from 'react';
import { progressFor } from '../lib/progress';
import { useReviewState } from '../reviewState';

/** Overall progress: share of the PR's hunks and hunkless files that are reviewed or auto-cleared. */
export function ProgressBar() {
  const { knownItemIds, status } = useReviewState();
  const p = useMemo(() => progressFor(knownItemIds, status), [knownItemIds, status]);
  const hasFiles = [...knownItemIds].some((id) => id.startsWith('file:'));
  return (
    <div
      className="mt-2 border-t border-gray-200 px-3 pt-2 pb-3 text-xs dark:border-gray-800"
      data-testid="overall-progress"
    >
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
          Progress
        </span>
        <span className="font-mono">{p.pct}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded bg-gray-200 dark:bg-gray-800"
        role="progressbar"
        aria-valuenow={p.pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Review progress"
      >
        <div className="flex h-full">
          <div
            className="bg-green-600"
            style={{ width: `${p.total ? (p.reviewed / p.total) * 100 : 0}%` }}
          />
          <div
            className="bg-sky-400/70 dark:bg-sky-500/50"
            style={{ width: `${p.total ? (p.auto / p.total) * 100 : 0}%` }}
          />
        </div>
      </div>
      <p className="mt-1 text-gray-500 dark:text-gray-400">
        {p.reviewed} reviewed
        {p.auto > 0 ? ` + ${p.auto} auto-cleared` : ''} of {p.total}{' '}
        {hasFiles ? 'items' : p.total === 1 ? 'hunk' : 'hunks'}
      </p>
    </div>
  );
}
