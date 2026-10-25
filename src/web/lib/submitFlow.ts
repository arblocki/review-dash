import type { UnsyncedDraft } from './draftSync';

export type SubmitOutcome<R> =
  { kind: 'unsynced'; failed: UnsyncedDraft[] } | { kind: 'submitted'; result: R };

/**
 * Submits only if every draft is confirmed on the server, since the server submits whatever it
 * has stored. Errors from `post` propagate to the caller.
 */
export async function runSubmit<R>(deps: {
  flush(): Promise<UnsyncedDraft[]>;
  post(): Promise<R>;
}): Promise<SubmitOutcome<R>> {
  const failed = await deps.flush();
  if (failed.length > 0) return { kind: 'unsynced', failed };
  return { kind: 'submitted', result: await deps.post() };
}
