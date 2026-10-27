import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Side } from '../diff/types.js';
import type { Analysis } from '../group/types.js';
import type { ReviewEvent } from '../github/types.js';
import { formatPrRef, type PrRef } from '../pr-ref.js';
import { MIGRATIONS } from './schema.js';

/** Where a draft's line sat inside its hunk when written; used to re-anchor after a push. */
export interface DraftAnchor {
  /** Index into `hunk.lines` of the commented (end) line. */
  index: number;
  /** Index of the range's first line, for multi-line drafts. */
  startIndex?: number;
  /** Text of the commented line, which must still match to re-anchor. */
  text: string;
}

export interface Draft {
  id: string;
  path: string;
  side: Side;
  line: number;
  startLine?: number;
  startSide?: Side;
  body: string;
  hunkId?: string;
  /** Head SHA of the PR the draft was written against. */
  headSha: string;
  /** The diff no longer contains the commented line; excluded from inline comments. */
  outdated: boolean;
  anchor?: DraftAnchor;
  updatedAt: string;
  /** Incremented on every upsert; lets a submission detect edits made while it was in flight. */
  revision: number;
}

export type DraftInput = Omit<Draft, 'id' | 'updatedAt' | 'revision' | 'outdated'> & {
  id?: string;
  outdated?: boolean;
};

export interface ReviewedHunk {
  hunkId: string;
  reviewedAt: string;
  /** PR head the hunk was marked reviewed at. */
  headSha: string;
}

export interface VerifyCheck {
  groupKey: string;
  itemIndex: number;
  checked: boolean;
}

export interface SubmittedReviewRecord {
  headSha: string;
  event: ReviewEvent;
  githubReviewId: number | null;
}

/** Cache key (with repo + pr): see PLAN 4.8. */
export interface AnalysisKey {
  headSha: string;
  diffHash: string;
  provider: string;
  model: string;
  promptVersion: string;
}

export interface Store {
  getAnalysis(ref: PrRef, key: AnalysisKey): Analysis | undefined;
  /** Inserts or replaces the cached analysis for the key. */
  saveAnalysis(ref: PrRef, key: AnalysisKey, analysis: Analysis): void;
  listDrafts(ref: PrRef): Draft[];
  /** Inserts or updates (by id) a draft; returns the stored row. */
  upsertDraft(ref: PrRef, input: DraftInput): Draft;
  deleteDraft(ref: PrRef, id: string): boolean;
  deleteDrafts(ref: PrRef, ids: string[]): void;
  /**
   * Deletes the drafts whose revision still matches the submitted snapshot, in one transaction.
   * Returns the ids of drafts kept because they were edited since the snapshot was taken.
   */
  deleteDraftsIfUnchanged(ref: PrRef, snapshot: { id: string; revision: number }[]): string[];
  /** Moves a draft onto the new diff after a push (clears `outdated`). */
  moveDraft(
    ref: PrRef,
    id: string,
    pos: { line: number; startLine?: number; headSha: string },
  ): void;
  markDraftOutdated(ref: PrRef, id: string): void;
  /** Marks hunks reviewed at `headSha`; hunks already marked keep their original record. */
  markReviewed(ref: PrRef, hunkIds: string[], headSha: string): void;
  unmarkReviewed(ref: PrRef, hunkIds: string[]): void;
  listReviewed(ref: PrRef): ReviewedHunk[];
  setVerifyCheck(ref: PrRef, groupKey: string, itemIndex: number, checked: boolean): void;
  listVerifyChecks(ref: PrRef): VerifyCheck[];
  /**
   * The head the reviewer is caught up to, which the re-review banner compares from: the newest
   * of an explicit checkpoint and a submitted review. With neither, the head of the earliest
   * reviewed-hunk mark. Marking hunks never advances it.
   */
  getReviewBaselineHeadSha(ref: PrRef): string | undefined;
  /** Records that the reviewer is caught up to `headSha` ("Done reviewing these changes"). */
  setReviewCheckpoint(ref: PrRef, headSha: string): void;
  recordSubmittedReview(ref: PrRef, rec: SubmittedReviewRecord): void;
  close(): void;
}

interface DraftRow {
  id: string;
  path: string;
  side: Side;
  line: number;
  start_line: number | null;
  start_side: Side | null;
  body: string;
  hunk_id: string | null;
  head_sha: string;
  outdated: number;
  anchor_index: number | null;
  anchor_start_index: number | null;
  anchor_text: string | null;
  updated_at: string;
  revision: number;
}

function toDraft(r: DraftRow): Draft {
  const d: Draft = {
    id: r.id,
    path: r.path,
    side: r.side,
    line: r.line,
    body: r.body,
    headSha: r.head_sha,
    outdated: r.outdated !== 0,
    updatedAt: r.updated_at,
    revision: r.revision,
  };
  if (r.start_line !== null) d.startLine = r.start_line;
  if (r.start_side !== null) d.startSide = r.start_side;
  if (r.hunk_id !== null) d.hunkId = r.hunk_id;
  if (r.anchor_index !== null && r.anchor_text !== null) {
    d.anchor = { index: r.anchor_index, text: r.anchor_text };
    if (r.anchor_start_index !== null) d.anchor.startIndex = r.anchor_start_index;
  }
  return d;
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Opens (creating and migrating) the database. Pass ':memory:' for tests. */
export function openStore(file: string): Store {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(db);

  const list = db.prepare<[string, number], DraftRow>(
    'SELECT * FROM drafts WHERE repo = ? AND pr = ? ORDER BY path, line, updated_at',
  );
  const upsert = db.prepare(`
    INSERT INTO drafts (id, repo, pr, path, side, line, start_line, start_side, body, hunk_id, head_sha,
      outdated, anchor_index, anchor_start_index, anchor_text, updated_at, revision)
    VALUES (@id, @repo, @pr, @path, @side, @line, @startLine, @startSide, @body, @hunkId, @headSha,
      @outdated, @anchorIndex, @anchorStartIndex, @anchorText, @updatedAt, 1)
    ON CONFLICT (id) DO UPDATE SET
      path = excluded.path, side = excluded.side, line = excluded.line,
      start_line = excluded.start_line, start_side = excluded.start_side, body = excluded.body,
      hunk_id = excluded.hunk_id, head_sha = excluded.head_sha, outdated = excluded.outdated,
      anchor_index = excluded.anchor_index, anchor_start_index = excluded.anchor_start_index,
      anchor_text = excluded.anchor_text, updated_at = excluded.updated_at,
      revision = drafts.revision + 1
    WHERE drafts.repo = excluded.repo AND drafts.pr = excluded.pr`);
  const get = db.prepare<[string, string, number], DraftRow>(
    'SELECT * FROM drafts WHERE id = ? AND repo = ? AND pr = ?',
  );
  const del = db.prepare('DELETE FROM drafts WHERE id = ? AND repo = ? AND pr = ?');
  const delIfRevision = db.prepare(
    'DELETE FROM drafts WHERE id = ? AND repo = ? AND pr = ? AND revision = ?',
  );
  const move = db.prepare(
    `UPDATE drafts SET line = ?, start_line = ?, head_sha = ?, outdated = 0
     WHERE id = ? AND repo = ? AND pr = ?`,
  );
  const outdate = db.prepare('UPDATE drafts SET outdated = 1 WHERE id = ? AND repo = ? AND pr = ?');
  const markStmt = db.prepare(
    `INSERT INTO reviewed_hunks (repo, pr, hunk_id, reviewed_at, head_sha) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo, pr, hunk_id) DO NOTHING`,
  );
  const unmarkStmt = db.prepare(
    'DELETE FROM reviewed_hunks WHERE repo = ? AND pr = ? AND hunk_id = ?',
  );
  const listReviewedStmt = db.prepare<
    [string, number],
    { hunk_id: string; reviewed_at: string; head_sha: string }
  >(
    'SELECT hunk_id, reviewed_at, head_sha FROM reviewed_hunks WHERE repo = ? AND pr = ? ORDER BY reviewed_at, hunk_id',
  );
  const setCheck = db.prepare(
    `INSERT INTO verify_checks (repo, pr, group_key, item_index, checked) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo, pr, group_key, item_index) DO UPDATE SET checked = excluded.checked`,
  );
  const listChecks = db.prepare<
    [string, number],
    { group_key: string; item_index: number; checked: number }
  >(
    'SELECT group_key, item_index, checked FROM verify_checks WHERE repo = ? AND pr = ? ORDER BY group_key, item_index',
  );
  const baseline = db.prepare<[string, number, string, number], { head_sha: string }>(
    `SELECT head_sha FROM (
       SELECT head_sha, created_at AS at FROM review_checkpoints WHERE repo = ? AND pr = ?
       UNION ALL
       SELECT head_sha, submitted_at AS at FROM reviews_submitted WHERE repo = ? AND pr = ?
     ) ORDER BY at DESC LIMIT 1`,
  );
  const firstMark = db.prepare<[string, number], { head_sha: string }>(
    `SELECT head_sha FROM reviewed_hunks WHERE repo = ? AND pr = ?
     ORDER BY reviewed_at, rowid LIMIT 1`,
  );
  const insertCheckpoint = db.prepare(
    'INSERT INTO review_checkpoints (repo, pr, head_sha, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertReview = db.prepare(`
    INSERT INTO reviews_submitted (repo, pr, head_sha, github_review_id, event, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?)`);

  const getAnalysisRow = db.prepare<
    [string, number, string, string, string, string, string],
    { json: string }
  >(
    `SELECT json FROM analyses WHERE repo = ? AND pr = ? AND head_sha = ? AND diff_hash = ?
     AND provider = ? AND model = ? AND prompt_version = ?`,
  );
  const putAnalysis = db.prepare(`
    INSERT OR REPLACE INTO analyses (repo, pr, head_sha, diff_hash, provider, model, prompt_version, json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    getAnalysis(ref, k) {
      const row = getAnalysisRow.get(
        `${ref.owner}/${ref.repo}`,
        ref.number,
        k.headSha,
        k.diffHash,
        k.provider,
        k.model,
        k.promptVersion,
      );
      if (!row) return undefined;
      try {
        return JSON.parse(row.json) as Analysis;
      } catch {
        return undefined; // corrupt row: treat as a miss
      }
    },
    saveAnalysis(ref, k, analysis) {
      putAnalysis.run(
        `${ref.owner}/${ref.repo}`,
        ref.number,
        k.headSha,
        k.diffHash,
        k.provider,
        k.model,
        k.promptVersion,
        JSON.stringify(analysis),
        new Date().toISOString(),
      );
    },
    listDrafts(ref) {
      return list.all(`${ref.owner}/${ref.repo}`, ref.number).map(toDraft);
    },
    upsertDraft(ref, input) {
      const repo = `${ref.owner}/${ref.repo}`;
      const id = input.id ?? randomUUID();
      const info = upsert.run({
        id,
        repo,
        pr: ref.number,
        path: input.path,
        side: input.side,
        line: input.line,
        startLine: input.startLine ?? null,
        startSide: input.startLine === undefined ? null : (input.startSide ?? input.side),
        body: input.body,
        hunkId: input.hunkId ?? null,
        headSha: input.headSha,
        outdated: input.outdated ? 1 : 0,
        anchorIndex: input.anchor?.index ?? null,
        anchorStartIndex: input.anchor?.startIndex ?? null,
        anchorText: input.anchor?.text ?? null,
        updatedAt: new Date().toISOString(),
      });
      const row = get.get(id, repo, ref.number);
      if (info.changes === 0 || !row) {
        throw new Error(`Draft ${id} belongs to a different pull request (${formatPrRef(ref)})`);
      }
      return toDraft(row);
    },
    deleteDraft(ref, id) {
      return del.run(id, `${ref.owner}/${ref.repo}`, ref.number).changes > 0;
    },
    deleteDrafts(ref, ids) {
      const repo = `${ref.owner}/${ref.repo}`;
      db.transaction(() => {
        for (const id of ids) del.run(id, repo, ref.number);
      })();
    },
    deleteDraftsIfUnchanged(ref, snapshot) {
      const repo = `${ref.owner}/${ref.repo}`;
      return db.transaction(() => {
        const kept: string[] = [];
        for (const { id, revision } of snapshot) {
          if (
            delIfRevision.run(id, repo, ref.number, revision).changes === 0 &&
            get.get(id, repo, ref.number)
          ) {
            kept.push(id);
          }
        }
        return kept;
      })();
    },
    moveDraft(ref, id, pos) {
      move.run(
        pos.line,
        pos.startLine ?? null,
        pos.headSha,
        id,
        `${ref.owner}/${ref.repo}`,
        ref.number,
      );
    },
    markDraftOutdated(ref, id) {
      outdate.run(id, `${ref.owner}/${ref.repo}`, ref.number);
    },
    markReviewed(ref, hunkIds, headSha) {
      const repo = `${ref.owner}/${ref.repo}`;
      const at = new Date().toISOString();
      db.transaction(() => {
        for (const id of hunkIds) markStmt.run(repo, ref.number, id, at, headSha);
      })();
    },
    unmarkReviewed(ref, hunkIds) {
      const repo = `${ref.owner}/${ref.repo}`;
      db.transaction(() => {
        for (const id of hunkIds) unmarkStmt.run(repo, ref.number, id);
      })();
    },
    listReviewed(ref) {
      return listReviewedStmt.all(`${ref.owner}/${ref.repo}`, ref.number).map((r) => ({
        hunkId: r.hunk_id,
        reviewedAt: r.reviewed_at,
        headSha: r.head_sha,
      }));
    },
    setVerifyCheck(ref, groupKey, itemIndex, checked) {
      setCheck.run(`${ref.owner}/${ref.repo}`, ref.number, groupKey, itemIndex, checked ? 1 : 0);
    },
    listVerifyChecks(ref) {
      return listChecks.all(`${ref.owner}/${ref.repo}`, ref.number).map((r) => ({
        groupKey: r.group_key,
        itemIndex: r.item_index,
        checked: r.checked !== 0,
      }));
    },
    getReviewBaselineHeadSha(ref) {
      const repo = `${ref.owner}/${ref.repo}`;
      return (
        baseline.get(repo, ref.number, repo, ref.number)?.head_sha ??
        firstMark.get(repo, ref.number)?.head_sha
      );
    },
    setReviewCheckpoint(ref, headSha) {
      insertCheckpoint.run(
        `${ref.owner}/${ref.repo}`,
        ref.number,
        headSha,
        new Date().toISOString(),
      );
    },
    recordSubmittedReview(ref, rec) {
      insertReview.run(
        `${ref.owner}/${ref.repo}`,
        ref.number,
        rec.headSha,
        rec.githubReviewId,
        rec.event,
        new Date().toISOString(),
      );
    },
    close() {
      db.close();
    },
  };
}
