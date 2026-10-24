#!/usr/bin/env node
import 'dotenv/config';
import open from 'open';
import { dbPath } from '../core/paths.js';
import { createGitHubClient, createOctokitClients } from '../core/github/client.js';
import { resolveToken } from '../core/github/token.js';
import { openStore } from '../core/store/index.js';
import { formatPrRef } from '../core/pr-ref.js';
import { startServer } from '../server/index.js';
import { parseCli, UsageError, USAGE } from './args.js';

async function main(): Promise<void> {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts === 'help') {
    console.log(USAGE);
    return;
  }

  const github = createGitHubClient(createOctokitClients(await resolveToken()));
  const store = openStore(dbPath());
  const server = await startServer({ pr: opts.pr, port: opts.port, github, store });
  const url = `http://127.0.0.1:${server.port}/#token=${server.token}`;
  console.log(`Reviewing ${formatPrRef(opts.pr)}`);
  if (opts.open) {
    console.log(`Opening http://127.0.0.1:${server.port}/ (session token not shown)`);
    await open(url);
  } else {
    console.log(`Open ${url}`);
    console.log('Note: this URL contains a session token; do not share or log it.');
  }

  const shutdown = () =>
    void server.close().then(() => {
      store.close();
      process.exit(0);
    });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
