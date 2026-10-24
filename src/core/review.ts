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
  force?: boolean;
}

export interface BuiltReview {
  payload: SubmitReviewInput;
  /** Drafts outside the diff hunks that were folded into the review body. */
  fallbacks: Draft[];
  /** Every draft that went into the review (inline or fallback). */
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

  const stale = drafts.filter((d) => d.headSha !== currentHeadSha);
  if (stale.length > 0 && !input.force) {
    throw new ReviewError(
      'head_moved',
      409,
      'The PR head moved since these drafts were written. Reload, or submit with force.',
      {
        currentHeadSha,
        draftHeadShas: [...new Set(stale.map((d) => d.headSha))],
        staleDraftIds: stale.map((d) => d.id),
      },
    );
  }

  const hunksByPath = new Map(files.map((f) => [f.path, f.hunks]));
  const comments: ReviewComment[] = [];
  const fallbacks: Draft[] = [];
  for (const d of drafts) {
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

  const extra = fallbacks.map((d) => {
    const range = d.startLine !== undefined ? `${d.startLine}-${d.line}` : `${d.line}`;
    return `\`${d.path}:${range}\` — ${d.body}`;
  });
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
    included: drafts,
  };
}
