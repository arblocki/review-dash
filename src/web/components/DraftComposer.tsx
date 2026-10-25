import { useState } from 'react';
import { useDraft, useReview } from '../state';

const STATUS_LABEL = {
  new: 'Not saved yet',
  dirty: 'Unsaved changes…',
  saving: 'Saving…',
  saved: 'Draft saved',
  error: 'Save failed, will retry on edit',
} as const;

/** Inline editor for one draft comment; autosaves via the review store. */
export function DraftComposer({ draftId, inline }: { draftId: string; inline: boolean }) {
  const draft = useDraft(draftId);
  const { updateDraftBody, deleteDraft } = useReview();
  // Local text keeps typing snappy; the store debounces the PUT.
  const [body, setBody] = useState(draft?.body ?? '');
  if (!draft) return null;

  const range =
    draft.startLine !== undefined && draft.startLine !== draft.line
      ? `lines ${draft.startLine}–${draft.line}`
      : `line ${draft.line}`;
  const empty = body.trim() === '';
  const status = draft.error
    ? draft.error
    : empty && draft.status !== 'saved' && !draft.persisted
      ? 'Write something to save'
      : STATUS_LABEL[draft.status];

  return (
    <div
      className="my-1 mr-2 ml-16 max-w-3xl rounded-md border border-blue-300 bg-white p-2 font-sans text-sm shadow-sm dark:border-blue-700 dark:bg-gray-900"
      data-testid="draft-composer"
    >
      <div className="mb-1 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>
          Draft comment on {draft.side === 'LEFT' ? 'old ' : ''}
          {range}
        </span>
        <span data-testid="draft-status">{status}</span>
      </div>
      {!inline && (
        <p className="mb-1 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
          This line is outside the diff, so GitHub can't show it inline. The comment will be added
          to the review body as <code>path:line — comment</code>.
        </p>
      )}
      <textarea
        autoFocus={draft.status === 'new'}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        className="w-full resize-y rounded border border-gray-300 bg-white p-1.5 font-sans dark:border-gray-700 dark:bg-gray-950"
        onChange={(e) => {
          setBody(e.target.value);
          updateDraftBody(draftId, e.target.value);
        }}
      />
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          className="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
          onClick={() => void deleteDraft(draftId)}
        >
          {draft.persisted ? 'Delete draft' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
