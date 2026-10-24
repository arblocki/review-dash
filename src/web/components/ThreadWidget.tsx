import { useState } from 'react';
import { useReview } from '../state';
import type { ReviewThread } from '../types';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** An existing GitHub review thread. Resolved threads start collapsed. */
export function ThreadWidget({
  thread,
  showLocation,
}: {
  thread: ReviewThread;
  showLocation?: boolean;
}) {
  const { replyToThread } = useReview();
  const [open, setOpen] = useState(!thread.isResolved);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = thread.comments[0];

  async function send() {
    if (!reply.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await replyToThread(thread, reply.trim());
      setReply('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`my-1 mr-2 ml-16 max-w-3xl rounded-md border font-sans text-sm ${
        thread.isResolved
          ? 'border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/60'
          : 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-900'
      }`}
      data-testid="thread"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-gray-600 dark:text-gray-300"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>
        {thread.isResolved && (
          <span className="rounded bg-green-100 px-1.5 text-green-800 dark:bg-green-900/50 dark:text-green-300">
            Resolved
          </span>
        )}
        {thread.isOutdated && (
          <span className="rounded bg-gray-200 px-1.5 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
            Outdated
          </span>
        )}
        {showLocation && (
          <span className="font-mono">
            {thread.path}
            {(thread.line ?? thread.originalLine) ? `:${thread.line ?? thread.originalLine}` : ''}
          </span>
        )}
        {!open && first && (
          <span className="min-w-0 flex-1 truncate">
            <b>{first.author ?? 'ghost'}</b>: {first.body}
          </span>
        )}
        {thread.comments.length > 1 && <span>{thread.comments.length} comments</span>}
      </button>
      {open && (
        <div className="border-t border-gray-200 dark:border-gray-800">
          {thread.comments.map((c) => (
            <div key={c.id} className="px-2 py-1.5">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                <b className="text-gray-800 dark:text-gray-100">{c.author ?? 'ghost'}</b>{' '}
                <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {when(c.createdAt)}
                </a>
              </div>
              <div className="whitespace-pre-wrap">{c.body}</div>
            </div>
          ))}
          {first?.databaseId ? (
            <div className="border-t border-gray-200 p-2 dark:border-gray-800">
              <textarea
                value={reply}
                rows={2}
                placeholder="Reply…"
                className="w-full resize-y rounded border border-gray-300 bg-white p-1.5 dark:border-gray-700 dark:bg-gray-950"
                onChange={(e) => setReply(e.target.value)}
              />
              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
              <div className="mt-1 flex justify-end">
                <button
                  type="button"
                  disabled={busy || !reply.trim()}
                  className="rounded bg-blue-600 px-2.5 py-0.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                  onClick={() => void send()}
                >
                  {busy ? 'Replying…' : 'Reply'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
