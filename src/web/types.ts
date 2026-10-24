import type { ParsedFile, Side } from '../core/diff/types';
import type { PrMeta, ReviewEvent } from '../core/github/types';

export type { Hunk, DiffLine, ParsedFile, Side, LineRange } from '../core/diff/types';
export type { PrMeta, ReviewThread, ThreadComment, ReviewEvent } from '../core/github/types';

export interface SessionInfo {
  label: string;
  pr: { owner: string; repo: string; number: number };
}

export interface PrResponse {
  pr: PrMeta;
  files: ParsedFile[];
  diffHash: string;
  viewer: string;
  isSelfReview: boolean;
}

/** Draft as stored by the server. */
export interface Draft {
  id: string;
  path: string;
  side: Side;
  line: number;
  startLine?: number;
  startSide?: Side;
  body: string;
  hunkId?: string;
  headSha: string;
  updatedAt: string;
}

export type DraftStatus = 'new' | 'dirty' | 'saving' | 'saved' | 'error';

/** A draft being edited locally; `persisted` once the server has a copy. */
export interface LocalDraft extends Omit<Draft, 'updatedAt'> {
  status: DraftStatus;
  persisted: boolean;
}

export interface SubmitResult {
  reviewUrl: string;
  fallbacks: Draft[];
}

export type { ReviewEvent as SubmitEvent };
