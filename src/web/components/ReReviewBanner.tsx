import { useState } from 'react';
import { interdiffTruncationNotes, reReviewText } from '../lib/rereview';
import { useReviewState } from '../reviewState';

export function HideReviewedToggle() {
  const { hideReviewed, setHideReviewed } = useReviewState();
  return (
    <label className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
      <input
        type="checkbox"
        checked={hideReviewed}
        onChange={(e) => setHideReviewed(e.target.checked)}
      />
      Hide reviewed hunks
    </label>
  );
}

/** Shown when the PR head differs from the head at the last submitted review. */
export function ReReviewBanner() {
  const { reReview, interdiff, markDoneReviewing } = useReviewState();
  const [open, setOpen] = useState(false);
  if (!reReview || !interdiff) return null;
  const notes = interdiffTruncationNotes(interdiff);
  const detail = reReview.kind === 'commits' && interdiff.newCommits.length > 0;
  return (
    <div
      className="mb-3 rounded border border-blue-300 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-100"
      data-testid="rereview-banner"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">{reReviewText(reReview)}</span>
        <span className="font-mono text-xs">
          {interdiff.reviewBaselineHeadSha?.slice(0, 7)} → {interdiff.currentHeadSha.slice(0, 7)}
        </span>
        {(detail || interdiff.changedFiles.length > 0) && (
          <button
            type="button"
            className="text-blue-700 hover:underline dark:text-blue-300"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide details' : 'Show commits and files'}
          </button>
        )}
        <span className="ml-auto flex items-center gap-3">
          <HideReviewedToggle />
          <button
            type="button"
            className="rounded border border-blue-400 px-2 py-0.5 text-blue-900 hover:bg-blue-100 dark:border-blue-700 dark:text-blue-100 dark:hover:bg-blue-900/50"
            onClick={() => void markDoneReviewing()}
          >
            Done reviewing these changes
          </button>
        </span>
      </div>
      {notes.map((n) => (
        <p key={n} className="mt-1 text-xs" data-testid="interdiff-truncated">
          {n}
        </p>
      ))}
      {open && (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {detail && (
            <div>
              <div className="text-xs font-semibold uppercase">Commits</div>
              <ul className="mt-1 space-y-0.5">
                {interdiff.newCommits.map((c) => (
                  <li key={c.sha} className="truncate" title={c.message}>
                    <code className="font-mono text-xs">{c.sha.slice(0, 7)}</code>{' '}
                    {c.message.split('\n')[0]}
                    {c.author ? <span className="text-xs opacity-70"> · {c.author}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {interdiff.changedFiles.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase">
                Files changed since ({interdiff.changedFiles.length})
              </div>
              <ul className="mt-1 space-y-0.5 font-mono text-xs">
                {interdiff.changedFiles.map((f) => (
                  <li key={f} className="truncate" title={f}>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
