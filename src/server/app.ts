import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { formatPrRef, type PrRef } from '../core/pr-ref.js';
import { hostGuard, tokenGuard } from './security.js';

export interface AppOptions {
  token: string;
  pr: PrRef;
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
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  const { webDir } = opts;
  if (webDir && existsSync(webDir)) {
    const index = readFileSync(`${webDir}/index.html`, 'utf8');
    app.use('*', serveStatic({ root: webDir }));
    app.get('*', (c) => c.html(index));
  }

  return app;
}
