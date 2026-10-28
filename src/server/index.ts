import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { RepoRef } from '../core/pr-ref.js';
import type { GitHubClient } from '../core/github/types.js';
import type { Store } from '../core/store/index.js';
import type { AnalysisDeps } from './analysis.js';
import { createApp } from './app.js';
import { generateToken } from './security.js';

export interface RunningServer {
  port: number;
  token: string;
  close: () => Promise<void>;
}

// src/server and dist/server are both two levels below the package root.
const WEB_DIR = resolve(fileURLToPath(import.meta.url), '../../../dist/web');

/** Starts the server on 127.0.0.1. Port 0 picks a random free port. */
export function startServer(opts: {
  repo?: RepoRef;
  initialPr?: number;
  port?: number;
  github: GitHubClient;
  store: Store;
  analysis?: AnalysisDeps;
}): Promise<RunningServer> {
  const token = generateToken();
  let port = opts.port ?? 0;
  const app = createApp({
    token,
    repo: opts.repo,
    initialPr: opts.initialPr,
    github: opts.github,
    store: opts.store,
    analysis: opts.analysis,
    port: () => port,
    webDir: WEB_DIR,
  });

  return new Promise((resolvePromise, reject) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info: AddressInfo) => {
      port = info.port;
      resolvePromise({
        port,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
    server.once('error', reject);
  });
}
