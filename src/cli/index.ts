#!/usr/bin/env node
import 'dotenv/config';
import open from 'open';
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

  const server = await startServer({ pr: opts.pr, port: opts.port });
  const url = `http://127.0.0.1:${server.port}/#token=${server.token}`;
  console.log(`Reviewing ${formatPrRef(opts.pr)}`);
  if (opts.open) {
    console.log(`Opening ${url}`);
    await open(url);
  } else {
    console.log(`Open ${url}`);
  }

  const shutdown = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
