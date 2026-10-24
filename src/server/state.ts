import type { Hono } from 'hono';
import { z } from 'zod';
import type { GitHubClient, PrCommit } from '../core/github/types.js';
import type { PrData } from '../core/pr-data.js';
import type { PrRef } from '../core/pr-ref.js';
import type { Store } from '../core/store/index.js';

export async function parseBody<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) {
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

const reviewedSchema = z.object({
  hunkIds: z.array(z.string().min(1)).max(10_000),
  reviewed: z.boolean(),
});

const verifySchema = z.object({
  groupKey: z.string().min(1),
  itemIndex: z.number().int().nonnegative(),
  checked: z.boolean(),
});

interface RouteDeps {
  pr: PrRef;
  github: GitHubClient;
  store: Store;
  /** `refresh` forces a re-fetch of the PR data. */
  getData: (refresh?: boolean) => Promise<PrData>;
}

export interface InterdiffResponse {
  /** Head the user last reviewed at; null when they have not reviewed anything yet. */
  lastReviewedHeadSha: string | null;
  currentHeadSha: string;
  newCommits: PrCommit[];
  changedFiles: string[];
  /** Hunks in the current diff whose id is not marked reviewed. */
  newHunkIds: string[];
  /** False when there is no previous review, or the old head is gone (force-push). */
  compareAvailable: boolean;
}

/**
 * Reviewed-state and re-review routes. Auto-cleared groups are not stored as reviewed
 * (PLAN section 12): the UI shows `autoClear` groups pre-checked, distinct from hunks the
 * user marked, and they do not count as reviewed on submit.
 */
export function registerStateApi(app: Hono, deps: RouteDeps): void {
  const { pr: ref, github, store, getData } = deps;

  app.get('/api/review-state', (c) => {
    const reviewed = store.listReviewed(ref);
    const verifyChecks: Record<string, number[]> = {};
    for (const v of store.listVerifyChecks(ref)) {
      if (v.checked) (verifyChecks[v.groupKey] ??= []).push(v.itemIndex);
    }
    const last = store.getLastReviewedHeadSha(ref);
    return c.json({
      reviewedHunkIds: reviewed.map((r) => r.hunkId),
      reviewedAt: Object.fromEntries(
        reviewed.map((r) => [r.hunkId, { reviewedAt: r.reviewedAt, headSha: r.headSha }]),
      ),
      verifyChecks,
      ...(last ? { lastReviewedHeadSha: last } : {}),
    });
  });

  app.put('/api/reviewed', async (c) => {
    const body = await parseBody(c, reviewedSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const { hunkIds, reviewed } = body.data;
    if (reviewed) store.markReviewed(ref, hunkIds, (await getData()).pr.headSha);
    else store.unmarkReviewed(ref, hunkIds);
    return c.json({ ok: true });
  });

  app.put('/api/verify', async (c) => {
    const body = await parseBody(c, verifySchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    store.setVerifyCheck(ref, body.data.groupKey, body.data.itemIndex, body.data.checked);
    return c.json({ ok: true });
  });

  app.get('/api/interdiff', async (c) => {
    const data = await getData(c.req.query('refresh') === '1');
    const currentHeadSha = data.pr.headSha;
    const last = store.getLastReviewedHeadSha(ref);
    const reviewed = new Set(store.listReviewed(ref).map((r) => r.hunkId));
    const newHunkIds = data.files
      .flatMap((f) => f.hunks)
      .map((h) => h.id)
      .filter((id) => !reviewed.has(id));

    const out: InterdiffResponse = {
      lastReviewedHeadSha: last ?? null,
      currentHeadSha,
      newCommits: [],
      changedFiles: [],
      newHunkIds,
      compareAvailable: false,
    };
    if (!last) return c.json(out);
    if (last === currentHeadSha) return c.json({ ...out, compareAvailable: true });
    const cmp = await github.compareCommits(ref, last, currentHeadSha);
    if (!cmp) return c.json(out);
    return c.json({
      ...out,
      newCommits: cmp.commits,
      changedFiles: cmp.files,
      compareAvailable: true,
    });
  });
}
