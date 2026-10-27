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
  /** Set when GitHub truncated the file list (3,000-file limit). */
  incomplete?: Incomplete;
}

export interface Incomplete {
  fetchedFiles: number;
  changedFiles: number;
  reason: string;
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
  /** The diff moved and the line no longer maps; goes into the review body. */
  outdated: boolean;
  updatedAt: string;
  revision: number;
}

export type DraftStatus = 'new' | 'dirty' | 'saving' | 'saved' | 'error';

/** A draft being edited locally; `persisted` once the server has a copy. */
export interface LocalDraft extends Omit<Draft, 'updatedAt' | 'revision'> {
  status: DraftStatus;
  persisted: boolean;
  /** Why the last save or delete failed (status 'error'). */
  error?: string;
  /** Deleted in the UI but the server still has it; the delete is retried on sync. */
  pendingDelete?: boolean;
}

export interface SubmitResult {
  reviewUrl: string;
  fallbacks: Draft[];
  /** Drafts written against an older head; they went into the review body. */
  outdated: Draft[];
  /** Ids of drafts edited during submission, so kept rather than deleted. */
  keptDrafts: string[];
}

export type { ReviewEvent as SubmitEvent };

export type { Analysis, AnalysisGroup, GroupKind } from '../core/group/types';
export type { Risk } from '../core/risk/types';

/** GET /api/analysis */
export interface AnalysisResponse {
  analysis: import('../core/group/types').Analysis;
  cached: boolean;
  shared?: boolean;
  /** The PR head and diff hash the analysis was computed for (absent from older servers). */
  headSha?: string;
  diffHash?: string;
  /** Problem with .review-dash.yaml (it was ignored). */
  configWarning?: string;
  /** The PR changes .review-dash.yaml: the base branch's rules were used instead. */
  configNotice?: string;
}

/** GET /api/providers */
export interface ProvidersResponse {
  current: { provider: string; model: string };
  available: string[];
  models: Record<string, string>;
}

/** GET /api/review-state */
export interface ReviewStateResponse {
  reviewedHunkIds: string[];
  reviewedAt: Record<string, { reviewedAt: string; headSha: string }>;
  verifyChecks: Record<string, { index: number; itemHash: string }[]>;
  lastReviewedHeadSha?: string;
}

/** GET /api/interdiff */
export interface InterdiffResponse {
  lastReviewedHeadSha: string | null;
  currentHeadSha: string;
  newCommits: { sha: string; message: string; author?: string | null; date?: string | null }[];
  changedFiles: string[];
  newHunkIds: string[];
  compareAvailable: boolean;
  totalCommits: number;
  commitsTruncated: boolean;
  filesTruncated: boolean;
}
