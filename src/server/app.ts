import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { formatPrRef, type PrRef } from '../core/pr-ref.js';
import type { GitHubClient } from '../core/github/types.js';
import type { Store } from '../core/store/index.js';
import type { AnalysisDeps } from './analysis.js';
import { registerApi } from './api.js';
import { hostGuard, tokenGuard } from './security.js';

export interface AppOptions {
  token: string;
  pr: PrRef;
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
  app.get('/api/session', (c) => c.json({ pr: opts.pr, label: formatPrRef(opts.pr) }));
  registerApi(app, {
    pr: opts.pr,
    github: opts.github,
    store: opts.store,
    analysis: opts.analysis,
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
