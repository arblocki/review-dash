import { Hono } from 'hono';
import { z } from 'zod';
import { loadPrData, type PrData } from '../core/pr-data.js';
import type { GitHubClient } from '../core/github/types.js';
import type { PrRef } from '../core/pr-ref.js';
import { computeAnchor, reanchorDraft } from '../core/reanchor.js';
import { buildReview, ReviewError } from '../core/review.js';
import type { Draft, DraftInput, Store } from '../core/store/index.js';
import { registerAnalysisApi, type AnalysisDeps } from './analysis.js';
import { parseBody, registerStateApi } from './state.js';

const sideSchema = z.enum(['LEFT', 'RIGHT']);

const draftSchema = z
  .object({
    id: z.string().min(1).optional(),
    path: z.string().min(1),
    side: sideSchema,
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    startSide: sideSchema.optional(),
    body: z.string().trim().min(1),
    hunkId: z.string().min(1).optional(),
    headSha: z.string().min(1),
  })
  .refine(
    // Line numbers only compare within one side; cross-side order is checked against the diff.
    (d) => d.startLine === undefined || (d.startSide ?? d.side) !== d.side || d.startLine <= d.line,
    { message: 'startLine must not be after line', path: ['startLine'] },
  );

const reviewSchema = z.object({
  event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
  body: z.string().default(''),
  /** Head SHA of the diff the client was displaying. */
  headSha: z.string().min(1),
  force: z.boolean().optional(),
});

const replySchema = z.object({ body: z.string().trim().min(1) });

/** Body for a failed GitHub call: only the message and upstream status, never headers or tokens. */
export function upstreamError(err: Error): { error: string; upstreamStatus?: number } {
  const status = (err as { status?: unknown }).status;
  return { error: err.message, ...(typeof status === 'number' ? { upstreamStatus: status } : {}) };
}

export interface ApiDeps {
  pr: PrRef;
  github: GitHubClient;
  store: Store;
  /** Enables /api/analysis and /api/providers. */
  analysis?: AnalysisDeps;
}

/** Registers the review API on `app`. Mount behind the token guard. */
export function registerApi(app: Hono, { pr: ref, github, store, analysis }: ApiDeps): void {
  // PR data is fetched once per server run; ?refresh=1 forces a re-fetch.
  let cached: Promise<PrData> | undefined;
  const getData = (refresh = false): Promise<PrData> => {
    if (refresh || !cached) {
      const p = loadPrData(github, ref);
      cached = p;
      p.catch(() => {
        if (cached === p) cached = undefined;
      });
    }
    return cached;
  };

  app.onError((err, c) => {
    if (err instanceof ReviewError) {
      return c.json(
        { error: err.message, code: err.code, ...err.details },
        err.status as 409 | 422,
      );
    }
    return c.json(upstreamError(err), 502);
  });

  app.get('/api/pr', async (c) => {
    const d = await getData(c.req.query('refresh') === '1');
    return c.json({
      pr: d.pr,
      files: d.files.map((f) => ({
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patchMissing: f.patchMissing,
        binary: f.binary,
        hunks: f.hunks,
      })),
      diffHash: d.diffHash,
      viewer: d.viewer,
      isSelfReview: d.isSelfReview,
      ...(d.incomplete ? { incomplete: d.incomplete } : {}),
    });
  });

  registerStateApi(app, { pr: ref, github, store, getData });

  if (analysis) {
    registerAnalysisApi(app, { pr: ref, github, store, getData: () => getData(), analysis });
  }

  app.get('/api/file', async (c) => {
    const path = c.req.query('path');
    const sha = c.req.query('ref');
    if (!path || !sha) return c.json({ error: 'path and ref are required' }, 400);
    return c.json({ content: await github.fetchFileContent(ref, path, sha) });
  });

  app.get('/api/threads', async (c) => c.json({ threads: await github.fetchReviewThreads(ref) }));

  /**
   * Lists drafts after moving any written against an older head onto `data`'s diff; the ones
   * that no longer map are marked outdated. Persists what it changes.
   */
  function reanchoredDrafts(data: PrData): Draft[] {
    const drafts = store.listDrafts(ref);
    let changed = false;
    for (const d of drafts) {
      const r = reanchorDraft(d, data.files, data.pr.headSha);
      if (r.kind === 'moved') {
        store.moveDraft(ref, d.id, {
          line: r.line,
          startLine: r.startLine,
          headSha: data.pr.headSha,
        });
        changed = true;
      } else if (r.kind === 'outdated') {
        store.markDraftOutdated(ref, d.id);
        changed = true;
      }
    }
    return changed ? store.listDrafts(ref) : drafts;
  }

  app.get('/api/drafts', async (c) => {
    // Without PR data (GitHub unreachable) the stored drafts are returned as they are.
    const data = await getData().catch(() => undefined);
    return c.json({ drafts: data ? reanchoredDrafts(data) : store.listDrafts(ref) });
  });

  app.put('/api/drafts', async (c) => {
    const body = await parseBody(c, draftSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const input: DraftInput = body.data;
    if (input.hunkId) {
      // Remember where the line sits in its hunk so the draft can follow it across pushes.
      const data = await getData().catch(() => undefined);
      if (data?.pr.headSha === input.headSha) {
        const hunk = data.files.flatMap((f) => f.hunks).find((h) => h.id === input.hunkId);
        if (hunk) input.anchor = computeAnchor(hunk, input);
      }
    }
    try {
      return c.json({ draft: store.upsertDraft(ref, input) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.delete('/api/drafts/:id', (c) => {
    const removed = store.deleteDraft(ref, c.req.param('id'));
    return removed ? c.json({ ok: true }) : c.json({ error: 'draft not found' }, 404);
  });

  app.post('/api/review', async (c) => {
    const body = await parseBody(c, reviewSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const { event, force, headSha: reviewedHeadSha } = body.data;

    // Always compare against the live head, and map comments against the live diff.
    const cachedData = await getData();
    const live = await github.fetchPr(ref);
    const data = live.headSha === cachedData.pr.headSha ? cachedData : await getData(true);

    const built = buildReview({
      drafts: reanchoredDrafts(data),
      files: data.files,
      event,
      body: body.data.body,
      viewer: data.viewer,
      prAuthor: data.pr.author,
      currentHeadSha: live.headSha,
      reviewedHeadSha,
      force,
    });
    const submitted = await github.submitReview(ref, built.payload);
    store.recordSubmittedReview(ref, {
      headSha: built.payload.headSha,
      event,
      githubReviewId: submitted.id,
    });
    // Drafts edited while the submission was in flight stay; the client tells the user.
    const keptDrafts = store.deleteDraftsIfUnchanged(
      ref,
      built.included.map((d) => ({ id: d.id, revision: d.revision })),
    );
    return c.json({
      reviewUrl: submitted.url,
      fallbacks: built.fallbacks,
      outdated: built.outdated,
      keptDrafts,
    });
  });

  app.post('/api/threads/:commentId/replies', async (c) => {
    const commentId = Number(c.req.param('commentId'));
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      return c.json({ error: 'invalid comment id' }, 400);
    }
    const body = await parseBody(c, replySchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const reply = await github.replyToComment(ref, commentId, body.data.body);
    return c.json({ id: reply.id, url: reply.url });
  });
}
