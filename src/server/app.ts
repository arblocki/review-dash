import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  formatPrRef,
  formatRepoRef,
  parseRepoRef,
  type PrRef,
  type RepoRef,
} from '../core/pr-ref.js';
import type { GitHubClient } from '../core/github/types.js';
import type { Store } from '../core/store/index.js';
import type { AnalysisDeps } from './analysis.js';
import { registerApi, upstreamError } from './api.js';
import { hostGuard, tokenGuard } from './security.js';

export interface AppOptions {
  token: string;
  /** Repository the UI opens on; without one it starts on the repository list. */
  repo?: RepoRef;
  /** PR in `repo` the UI opens first; without one it starts on the repo's open-PR list. */
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
    const repo = opts.repo ?? null;
    const pr: PrRef | null =
      repo && opts.initialPr !== undefined ? { ...repo, number: opts.initialPr } : null;
    return c.json({
      repo,
      pr,
      label: pr ? formatPrRef(pr) : repo ? formatRepoRef(repo) : 'review-dash',
    });
  });
  app.get('/api/repos', async (c) => c.json({ repos: await opts.github.listRepos() }));

  // Repository routes; `:owner/:repo` must be a valid GitHub name pair.
  const repoOf = (c: { req: { param(name: string): string } }): RepoRef | null =>
    parseRepoRef(`${c.req.param('owner')}/${c.req.param('repo')}`);
  app.get('/api/repos/:owner/:repo/pulls', async (c) => {
    const repo = repoOf(c);
    if (!repo) return c.json({ error: 'invalid repository' }, 400);
    return c.json({ pulls: await opts.github.listOpenPrs(repo) });
  });

  // Each PR gets its own sub-app (with its own PR-data and analysis caches), created on first
  // use. `/api/repos/:owner/:repo/pulls/:number/<route>` is served by that app's `/api/<route>`.
  const prApps = new Map<string, Hono>();
  const prApp = (pr: PrRef): Hono => {
    const key = formatPrRef(pr);
    let sub = prApps.get(key);
    if (!sub) {
      sub = new Hono();
      registerApi(sub, {
        pr,
        github: opts.github,
        store: opts.store,
        analysis: opts.analysis,
      });
      sub.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
      prApps.set(key, sub);
    }
    return sub;
  };
  app.all('/api/repos/:owner/:repo/pulls/:number/*', (c) => {
    const repo = repoOf(c);
    if (!repo) return c.json({ error: 'invalid repository' }, 400);
    const raw = c.req.param('number');
    const number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1) {
      return c.json({ error: 'invalid pull request number' }, 400);
    }
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/api\/repos\/[^/]+\/[^/]+\/pulls\/\d+/, '/api');
    return prApp({ ...repo, number }).fetch(new Request(url, c.req.raw));
  });
  app.onError((err, c) => c.json(upstreamError(err), 502));
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
