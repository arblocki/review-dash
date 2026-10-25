import type { UnsyncedDraft } from './draftSync';

export type SubmitOutcome<R> =
  | { kind: 'unsynced'; failed: UnsyncedDraft[] }
  // `refreshError` is set when the review went through but reloading page data failed.
  | { kind: 'submitted'; result: R; refreshError?: string };

/**
 * Submits only if every draft is confirmed on the server, since the server submits whatever it
 * has stored. Errors from `post` propagate to the caller; once it succeeds the submission is
 * reported as done even if `reload` fails.
 */
export async function runSubmit<R>(deps: {
  flush(): Promise<UnsyncedDraft[]>;
  post(): Promise<R>;
  reload(): Promise<void>;
}): Promise<SubmitOutcome<R>> {
  const failed = await deps.flush();
  if (failed.length > 0) return { kind: 'unsynced', failed };
  const result = await deps.post();
  try {
    await deps.reload();
  } catch (err) {
    return { kind: 'submitted', result, refreshError: (err as Error).message };
  }
  return { kind: 'submitted', result };
}
