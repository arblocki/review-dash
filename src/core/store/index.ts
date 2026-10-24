import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Side } from '../diff/types.js';
import type { ReviewEvent } from '../github/types.js';
import { formatPrRef, type PrRef } from '../pr-ref.js';
import { MIGRATIONS } from './schema.js';

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
  updatedAt: string;
}

export type DraftInput = Omit<Draft, 'id' | 'updatedAt'> & { id?: string };

export interface SubmittedReviewRecord {
  headSha: string;
  event: ReviewEvent;
  githubReviewId: number | null;
}

export interface Store {
  listDrafts(ref: PrRef): Draft[];
  /** Inserts or updates (by id) a draft; returns the stored row. */
  upsertDraft(ref: PrRef, input: DraftInput): Draft;
  deleteDraft(ref: PrRef, id: string): boolean;
  deleteDrafts(ref: PrRef, ids: string[]): void;
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
  updated_at: string;
}

function toDraft(r: DraftRow): Draft {
  const d: Draft = {
    id: r.id,
    path: r.path,
    side: r.side,
    line: r.line,
    body: r.body,
    headSha: r.head_sha,
    updatedAt: r.updated_at,
  };
  if (r.start_line !== null) d.startLine = r.start_line;
  if (r.start_side !== null) d.startSide = r.start_side;
  if (r.hunk_id !== null) d.hunkId = r.hunk_id;
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
    INSERT INTO drafts (id, repo, pr, path, side, line, start_line, start_side, body, hunk_id, head_sha, updated_at)
    VALUES (@id, @repo, @pr, @path, @side, @line, @startLine, @startSide, @body, @hunkId, @headSha, @updatedAt)
    ON CONFLICT (id) DO UPDATE SET
      path = excluded.path, side = excluded.side, line = excluded.line,
      start_line = excluded.start_line, start_side = excluded.start_side, body = excluded.body,
      hunk_id = excluded.hunk_id, head_sha = excluded.head_sha, updated_at = excluded.updated_at
    WHERE drafts.repo = excluded.repo AND drafts.pr = excluded.pr`);
  const get = db.prepare<[string, string, number], DraftRow>(
    'SELECT * FROM drafts WHERE id = ? AND repo = ? AND pr = ?',
  );
  const del = db.prepare('DELETE FROM drafts WHERE id = ? AND repo = ? AND pr = ?');
  const insertReview = db.prepare(`
    INSERT INTO reviews_submitted (repo, pr, head_sha, github_review_id, event, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?)`);

  return {
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
