import { ApiError } from '../api';

export interface ReviewedErrorInfo {
  message: string;
  /** A stale-head conflict: the fix is refreshing the PR, not retrying. */
  needsRefresh: boolean;
}

/** What to show when `PUT /api/reviewed` fails (409 head_moved, 400 unknown ids, or anything else). */
export function describeReviewedError(err: unknown): ReviewedErrorInfo {
  if (err instanceof ApiError && err.status === 409 && err.code === 'head_moved') {
    const sha = err.body.currentHeadSha;
    const head = typeof sha === 'string' && sha ? ` (new head ${sha.slice(0, 7)})` : '';
    return {
      message: `The PR changed${head}. Refresh to review the new version.`,
      needsRefresh: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { message: `Could not save reviewed state: ${message}`, needsRefresh: false };
}
