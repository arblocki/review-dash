import type { InterdiffResponse } from '../types';

export type ReReview =
  | { kind: 'commits'; count: number }
  /** The old head is gone (force-push), so commits can't be listed. */
  | { kind: 'rewritten' };

/** What the re-review banner says, or null when there is nothing new since the last review. */
export function reReviewInfo(i: InterdiffResponse | null): ReReview | null {
  if (!i || !i.lastReviewedHeadSha || i.lastReviewedHeadSha === i.currentHeadSha) return null;
  if (!i.compareAvailable) return { kind: 'rewritten' };
  return { kind: 'commits', count: i.newCommits.length };
}

export function reReviewText(r: ReReview): string {
  if (r.kind === 'rewritten') return 'History was rewritten; showing unreviewed hunks';
  return `${r.count} new ${r.count === 1 ? 'commit' : 'commits'} since you last reviewed`;
}

/** "Hide reviewed hunks" is on by default only when the banner applies, unless the user chose. */
export function effectiveHideReviewed(choice: boolean | null, banner: ReReview | null): boolean {
  return choice ?? banner !== null;
}
