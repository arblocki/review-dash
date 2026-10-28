import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, jsonBody, prUrl } from '../api';
import { classifyDraft } from '../lib/diffModel';
import type { UnsyncedDraft } from '../lib/draftSync';
import { runSubmit } from '../lib/submitFlow';
import { useReviewState } from '../reviewState';
import { useDrafts, useReview } from '../state';
import type { LineRange, SubmitEvent, SubmitResult } from '../types';

type Phase =
  | { kind: 'saving' }
  | { kind: 'ready' }
  | { kind: 'submitting' }
  | { kind: 'unsynced'; failed: UnsyncedDraft[] }
  | { kind: 'head_moved'; event: SubmitEvent; currentHeadSha: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: SubmitResult; refreshError?: string };

const afterFlush = (failed: UnsyncedDraft[]): Phase =>
  failed.length > 0 ? { kind: 'unsynced', failed } : { kind: 'ready' };

function rangeLabel(d: { line: number; startLine?: number }): string {
  return d.startLine !== undefined && d.startLine !== d.line
    ? `${d.startLine}-${d.line}`
    : String(d.line);
}

export function SubmitModal({ onClose }: { onClose: () => void }) {
  const { files, pr, isSelfReview, flushDrafts, reloadAfterSubmit, refresh, refreshing } =
    useReview();
  const { checkHead, reloadInterdiff } = useReviewState();
  // Head on GitHub right now, if it differs from the one this page loaded (PLAN section 3).
  const [liveHead, setLiveHead] = useState<string | null>(null);
  const drafts = useDrafts();
  const [body, setBody] = useState('');
  const [retryingRefresh, setRetryingRefresh] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'saving' });

  // Make sure the server has the latest text of every draft before listing them.
  useEffect(() => {
    let cancelled = false;
    flushDrafts().then((failed) => !cancelled && setPhase(afterFlush(failed)));
    return () => {
      cancelled = true;
    };
  }, [flushDrafts]);

  async function retrySaving() {
    setPhase({ kind: 'saving' });
    setPhase(afterFlush(await flushDrafts()));
  }
  useEffect(() => {
    let cancelled = false;
    void checkHead().then((sha) => !cancelled && setLiveHead(sha));
    return () => {
      cancelled = true;
    };
  }, [checkHead]);
  const headMoved = liveHead !== null && liveHead !== pr.headSha;

  const items = useMemo(() => {
    const byPath = new Map(files.map((f) => [f.path, f.hunks]));
    return drafts
      .filter((d) => d.body.trim() && d.persisted)
      .map((d) => {
        const range: LineRange = {
          line: d.line,
          side: d.side,
          startLine: d.startLine,
          startSide: d.startSide,
        };
        return {
          draft: d,
          // Re-anchoring flags drafts whose line no longer fits the new diff as outdated.
          kind: d.outdated
            ? ('outdated' as const)
            : classifyDraft({ ...d, ...range }, pr.headSha, byPath.get(d.path) ?? []),
        };
      });
  }, [drafts, files, pr.headSha]);

  async function retryRefresh() {
    if (phase.kind !== 'done') return;
    const { result } = phase;
    setRetryingRefresh(true);
    try {
      await reloadAfterSubmit();
      setPhase({ kind: 'done', result });
    } catch (err) {
      setPhase({ kind: 'done', result, refreshError: (err as Error).message });
    } finally {
      setRetryingRefresh(false);
    }
  }

  async function submit(event: SubmitEvent, force = false) {
    setPhase({ kind: 'submitting' });
    try {
      const outcome = await runSubmit({
        flush: flushDrafts,
        post: () =>
          api<SubmitResult>(prUrl('/review'), {
            method: 'POST',
            // The head we are showing; the server refuses with head_moved if GitHub has moved on.
            ...jsonBody({ event, body, headSha: pr.headSha, ...(force ? { force: true } : {}) }),
          }),
        reload: reloadAfterSubmit,
      });
      if (outcome.kind === 'unsynced') {
        setPhase({ kind: 'unsynced', failed: outcome.failed });
        return;
      }
      void reloadInterdiff();
      setPhase({ kind: 'done', result: outcome.result, refreshError: outcome.refreshError });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'head_moved') {
        setPhase({
          kind: 'head_moved',
          event,
          currentHeadSha: String(err.body.currentHeadSha ?? ''),
        });
      } else {
        setPhase({ kind: 'error', message: (err as Error).message });
      }
    }
  }

  const busy = phase.kind === 'saving' || phase.kind === 'submitting' || phase.kind === 'unsynced';
  // Unsynced drafts block submitting, not closing: the user may need to go fix them.
  const closable = phase.kind !== 'saving' && phase.kind !== 'submitting';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closable && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closable, onClose]);
  const done = phase.kind === 'done';
  const fallbackCount = items.filter((i) => i.kind === 'fallback').length;
  const outdatedCount = items.filter((i) => i.kind === 'outdated').length;
  const btn = 'rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:pt-16"
      role="dialog"
      aria-modal="true"
      aria-label="Submit review"
      onClick={(e) => e.target === e.currentTarget && closable && onClose()}
    >
      <div className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Submit review</h2>
          <button type="button" className="text-gray-500" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {done ? (
          <div data-testid="submit-success">
            <p className="text-green-700 dark:text-green-400">Review submitted.</p>
            <p className="mt-1 text-sm">
              <a
                href={phase.result.reviewUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                View the review on GitHub ↗
              </a>
            </p>
            {phase.refreshError !== undefined && (
              <div
                className="mt-2 rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                role="alert"
                data-testid="refresh-warning"
              >
                Review submitted, but refreshing the page data failed: {phase.refreshError}
                <div className="mt-2">
                  <button
                    type="button"
                    disabled={retryingRefresh}
                    className={`${btn} bg-amber-600 hover:bg-amber-700`}
                    onClick={() => void retryRefresh()}
                  >
                    {retryingRefresh ? 'Refreshing…' : 'Retry refresh'}
                  </button>
                </div>
              </div>
            )}
            {phase.result.fallbacks.length > 0 && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {phase.result.fallbacks.length} comment(s) outside the diff were added to the review
                body.
              </p>
            )}
            {phase.result.outdated.length > 0 && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {phase.result.outdated.length} outdated comment(s) were added to the review body.
              </p>
            )}
            {phase.result.keptDrafts.length > 0 && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {phase.result.keptDrafts.length} draft(s) were edited during submission and were
                kept as drafts.
              </p>
            )}
            <div className="mt-4 text-right">
              <button
                type="button"
                className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <h3 className="text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
              Drafts ({items.length})
            </h3>
            {items.length === 0 ? (
              <p className="py-2 text-sm text-gray-500 dark:text-gray-400">No inline drafts.</p>
            ) : (
              <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto">
                {items.map(({ draft, kind }) => (
                  <li
                    key={draft.id}
                    className="rounded border border-gray-200 p-2 text-sm dark:border-gray-700"
                  >
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <span className="min-w-0 flex-1 truncate">
                        {draft.path}:{rangeLabel(draft)}
                      </span>
                      {kind !== 'inline' && (
                        <span className="shrink-0 rounded bg-amber-100 px-1.5 font-sans text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                          {kind === 'outdated'
                            ? 'outdated — will go into the review body'
                            : 'goes in review body'}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap">{draft.body}</div>
                  </li>
                ))}
              </ul>
            )}
            {fallbackCount > 0 && (
              <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                {fallbackCount} comment(s) are outside the diff, so GitHub can&apos;t place them
                inline. They are appended to the review body as <code>path:line — comment</code>.
              </p>
            )}
            {headMoved && (
              <div
                className="mt-3 rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                data-testid="head-moved-warning"
              >
                The PR head moved to <code>{liveHead.slice(0, 7)}</code> since this page loaded (
                <code>{pr.headSha.slice(0, 7)}</code>). Refresh to see the new diff; drafts are
                moved onto it, and the ones that no longer fit become outdated.
                <div className="mt-2">
                  <button
                    type="button"
                    disabled={refreshing}
                    className={`${btn} bg-amber-600 hover:bg-amber-700`}
                    onClick={() => void refresh()}
                  >
                    {refreshing ? 'Refreshing…' : 'Refresh PR'}
                  </button>
                </div>
              </div>
            )}

            {outdatedCount > 0 && (
              <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                {outdatedCount} comment(s) were written against an older head, so their line numbers
                may not match. They are appended to the review body, never posted inline.
              </p>
            )}

            <label className="mt-3 block text-sm font-medium" htmlFor="review-body">
              Review summary (optional)
            </label>
            <textarea
              id="review-body"
              value={body}
              rows={4}
              className="mt-1 w-full resize-y rounded border border-gray-300 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-950"
              onChange={(e) => setBody(e.target.value)}
            />

            {phase.kind === 'head_moved' && (
              <div
                className="mt-3 rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                data-testid="head-moved"
              >
                The PR head moved to <code>{phase.currentHeadSha.slice(0, 7)}</code> since you
                loaded it at <code>{pr.headSha.slice(0, 7)}</code>, so this review would cover
                commits you have not seen. Refresh to review them, or submit anyway.
                <div className="mt-2">
                  <button
                    type="button"
                    className={`${btn} bg-amber-600 hover:bg-amber-700`}
                    onClick={() => void submit(phase.event, true)}
                  >
                    Submit anyway
                  </button>
                </div>
              </div>
            )}
            {phase.kind === 'unsynced' && (
              <div
                className="mt-3 rounded border border-red-400 bg-red-50 p-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-200"
                role="alert"
                data-testid="unsynced-drafts"
              >
                Some drafts could not be saved, so the review was not submitted:
                <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                  {phase.failed.map((f) => (
                    <li key={f.id}>
                      {f.path}:{rangeLabel(f)} <span className="font-sans">({f.message})</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2">
                  <button
                    type="button"
                    className={`${btn} bg-red-600 hover:bg-red-700`}
                    onClick={() => void retrySaving()}
                  >
                    Retry saving
                  </button>
                </div>
              </div>
            )}
            {phase.kind === 'error' && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
                {phase.message}
              </p>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
                onClick={onClose}
                disabled={phase.kind === 'submitting'}
              >
                Cancel
              </button>
              {!isSelfReview && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${btn} bg-red-600 hover:bg-red-700`}
                    onClick={() => void submit('REQUEST_CHANGES')}
                  >
                    Request changes
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${btn} bg-green-600 hover:bg-green-700`}
                    onClick={() => void submit('APPROVE')}
                  >
                    Approve
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={busy}
                className={`${btn} bg-blue-600 hover:bg-blue-700`}
                onClick={() => void submit('COMMENT')}
              >
                {phase.kind === 'submitting' ? 'Submitting…' : 'Comment'}
              </button>
            </div>
            {isSelfReview && (
              <p className="mt-2 text-right text-xs text-gray-500 dark:text-gray-400">
                This is your own PR, so GitHub only allows submitting as a comment.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
