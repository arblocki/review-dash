import { isCommentable } from './diff/lines.js';
import type { ParsedFile } from './diff/types.js';
import type { ReviewComment, ReviewEvent, SubmitReviewInput } from './github/types.js';
import type { Draft } from './store/index.js';

export type ReviewErrorCode = 'self_review' | 'head_moved' | 'empty_review';

export class ReviewError extends Error {
  constructor(
    readonly code: ReviewErrorCode,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface BuildReviewInput {
  drafts: Draft[];
  files: ParsedFile[];
  event: ReviewEvent;
  body: string;
  viewer: string;
  prAuthor: string;
  currentHeadSha: string;
  /** Head SHA of the diff the reviewer was looking at when they clicked submit. */
  reviewedHeadSha: string;
  force?: boolean;
}

export interface BuiltReview {
  payload: SubmitReviewInput;
  /** Drafts outside the diff hunks that were folded into the review body. */
  fallbacks: Draft[];
  /**
   * Drafts written against an older head. Their coordinates are ambiguous against the current
   * diff, so they are never posted inline; they go in the body with an outdated label.
   */
  outdated: Draft[];
  /** Every draft that went into the review (inline, fallback or outdated). */
  included: Draft[];
}

/** Turns drafts into a GitHub review payload, applying the plan's section 3 rules. */
export function buildReview(input: BuildReviewInput): BuiltReview {
  const { drafts, files, event, viewer, prAuthor, currentHeadSha } = input;

  if (event !== 'COMMENT' && viewer.toLowerCase() === prAuthor.toLowerCase()) {
    throw new ReviewError(
      'self_review',
      422,
      'You cannot approve or request changes on your own pull request; submit as COMMENT.',
    );
  }

  // Checked even with no drafts: a bare approval must not land on commits nobody looked at.
  // Outdated drafts never go inline, so they do not block submission.
  const stale = drafts.filter((d) => !d.outdated && d.headSha !== currentHeadSha);
  if ((input.reviewedHeadSha !== currentHeadSha || stale.length > 0) && !input.force) {
    throw new ReviewError(
      'head_moved',
      409,
      'The PR head moved since you loaded it. Reload to review the new commits, or submit with force.',
      {
        currentHeadSha,
        reviewedHeadSha: input.reviewedHeadSha,
        draftHeadShas: [...new Set(stale.map((d) => d.headSha))],
        staleDraftIds: stale.map((d) => d.id),
      },
    );
  }

  const hunksByPath = new Map(files.map((f) => [f.path, f.hunks]));
  const comments: ReviewComment[] = [];
  const fallbacks: Draft[] = [];
  const outdated: Draft[] = [];
  for (const d of drafts) {
    // `force` only means "submit deliberately": it must not reuse line numbers from another head.
    // Re-anchored drafts carry the current headSha; ones that could not follow are `outdated`.
    if (d.outdated || d.headSha !== currentHeadSha) {
      outdated.push(d);
      continue;
    }
    const ok = isCommentable(hunksByPath.get(d.path) ?? [], {
      line: d.line,
      side: d.side,
      startLine: d.startLine,
      startSide: d.startSide,
    });
    if (!ok) {
      fallbacks.push(d);
      continue;
    }
    const c: ReviewComment = { path: d.path, body: d.body, line: d.line, side: d.side };
    if (d.startLine !== undefined) {
      c.start_line = d.startLine;
      c.start_side = d.startSide ?? d.side;
    }
    comments.push(c);
  }

  const location = (d: Draft) =>
    `\`${d.path}:${d.startLine !== undefined ? `${d.startLine}-${d.line}` : d.line}\``;
  const extra = [
    ...fallbacks.map((d) => `${location(d)} — ${d.body}`),
    ...outdated.map(
      (d) => `${location(d)} (outdated: written against ${d.headSha.slice(0, 7)}) — ${d.body}`,
    ),
  ];
  const body = [input.body.trim(), ...extra].filter(Boolean).join('\n\n');

  if (comments.length === 0 && body === '' && event !== 'APPROVE') {
    throw new ReviewError(
      'empty_review',
      422,
      'Nothing to submit: add a comment or a review body.',
    );
  }

  return {
    payload: { headSha: currentHeadSha, event, body, comments },
    fallbacks,
    outdated,
    included: drafts,
  };
}
