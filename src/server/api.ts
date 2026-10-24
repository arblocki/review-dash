import { Hono } from 'hono';
import { z } from 'zod';
import { loadPrData, type PrData } from '../core/pr-data.js';
import type { GitHubClient } from '../core/github/types.js';
import type { PrRef } from '../core/pr-ref.js';
import { buildReview, ReviewError } from '../core/review.js';
import type { Store } from '../core/store/index.js';

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
  .refine((d) => d.startLine === undefined || d.startLine <= d.line, {
    message: 'startLine must not be after line',
    path: ['startLine'],
  });

const reviewSchema = z.object({
  event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
  body: z.string().default(''),
  force: z.boolean().optional(),
});

const replySchema = z.object({ body: z.string().trim().min(1) });

export interface ApiDeps {
  pr: PrRef;
  github: GitHubClient;
  store: Store;
}

/** Registers the review API on `app`. Mount behind the token guard. */
export function registerApi(app: Hono, { pr: ref, github, store }: ApiDeps): void {
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
    const status = (err as { status?: unknown }).status;
    // Never echo request headers or tokens: only the message and upstream status.
    return c.json(
      {
        error: err.message,
        ...(typeof status === 'number' ? { upstreamStatus: status } : {}),
      },
      502,
    );
  });

  async function parseBody<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return { error: 'invalid JSON body' } as const;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return {
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      } as const;
    }
    return { data: parsed.data } as const;
  }

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
    });
  });

  app.get('/api/file', async (c) => {
    const path = c.req.query('path');
    const sha = c.req.query('ref');
    if (!path || !sha) return c.json({ error: 'path and ref are required' }, 400);
    return c.json({ content: await github.fetchFileContent(ref, path, sha) });
  });

  app.get('/api/threads', async (c) => c.json({ threads: await github.fetchReviewThreads(ref) }));

  app.get('/api/drafts', (c) => c.json({ drafts: store.listDrafts(ref) }));

  app.put('/api/drafts', async (c) => {
    const body = await parseBody(c, draftSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    try {
      return c.json({ draft: store.upsertDraft(ref, body.data) });
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
    const { event, force } = body.data;

    // Always compare against the live head, and map comments against the live diff.
    const cachedData = await getData();
    const live = await github.fetchPr(ref);
    const data = live.headSha === cachedData.pr.headSha ? cachedData : await getData(true);

    const built = buildReview({
      drafts: store.listDrafts(ref),
      files: data.files,
      event,
      body: body.data.body,
      viewer: data.viewer,
      prAuthor: data.pr.author,
      currentHeadSha: live.headSha,
      force,
    });
    const submitted = await github.submitReview(ref, built.payload);
    store.recordSubmittedReview(ref, {
      headSha: built.payload.headSha,
      event,
      githubReviewId: submitted.id,
    });
    store.deleteDrafts(
      ref,
      built.included.map((d) => d.id),
    );
    return c.json({ reviewUrl: submitted.url, fallbacks: built.fallbacks });
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
