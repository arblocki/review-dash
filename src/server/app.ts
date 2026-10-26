import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { formatPrRef, formatRepoRef, type PrRef, type RepoRef } from '../core/pr-ref.js';
import type { GitHubClient } from '../core/github/types.js';
import type { Store } from '../core/store/index.js';
import type { AnalysisDeps } from './analysis.js';
import { registerApi } from './api.js';
import { hostGuard, tokenGuard } from './security.js';

export interface AppOptions {
  token: string;
  repo: RepoRef;
  /** PR the UI opens first; without one it starts on the open-PR list. */
  initialPr?: number;
  github: GitHubClient;
  store: Store;
  analysis?: AnalysisDeps;
  /** Port the server listens on; used for Host/Origin checks. May be set after listen(). */
  port: () => number;
  /** Directory containing the built UI. Omit to skip static serving. */
  webDir?: string;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  app.use('*', hostGuard(opts.port));
  app.use('/api/*', tokenGuard(opts.token));

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/session', (c) => {
    const pr: PrRef | null =
      opts.initialPr === undefined ? null : { ...opts.repo, number: opts.initialPr };
    return c.json({
      repo: opts.repo,
      pr,
      label: pr ? formatPrRef(pr) : formatRepoRef(opts.repo),
    });
  });
  app.get('/api/pulls', async (c) => {
    try {
      return c.json({ pulls: await opts.github.listOpenPrs(opts.repo) });
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      return c.json(
        {
          error: (err as Error).message,
          ...(typeof status === 'number' ? { upstreamStatus: status } : {}),
        },
        502,
      );
    }
  });

  // Each PR gets its own sub-app (with its own PR-data and analysis caches), created on first
  // use. `/api/pulls/:number/<route>` is served by that app's `/api/<route>`.
  const prApps = new Map<number, Hono>();
  const prApp = (number: number): Hono => {
    let sub = prApps.get(number);
    if (!sub) {
      sub = new Hono();
      registerApi(sub, {
        pr: { ...opts.repo, number },
        github: opts.github,
        store: opts.store,
        analysis: opts.analysis,
      });
      sub.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
      prApps.set(number, sub);
    }
    return sub;
  };
  app.all('/api/pulls/:number/*', (c) => {
    const raw = c.req.param('number');
    const number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1) {
      return c.json({ error: 'invalid pull request number' }, 400);
    }
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/api\/pulls\/\d+/, '/api');
    return prApp(number).fetch(new Request(url, c.req.raw));
  });
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  const { webDir } = opts;
  if (webDir) {
    // Mounted even if webDir does not exist yet (`vite build --watch` race); index.html is
    // read per request so rebuilds are picked up without a restart.
    app.use('*', serveStatic({ root: webDir }));
    app.get('*', (c) => {
      try {
        return c.html(readFileSync(`${webDir}/index.html`, 'utf8'));
      } catch {
        return c.text(
          'UI not built yet — run `pnpm build` (or wait for `pnpm dev` to finish building)',
          503,
        );
      }
    });
  }

  return app;
}
