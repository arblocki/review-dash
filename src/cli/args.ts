import { parseArgs } from 'node:util';
import { isProviderId, PROVIDER_IDS, type ProviderId } from '../core/llm/types.js';
import { parsePrRef, parseRepoRef, type RepoRef } from '../core/pr-ref.js';

export interface CliOptions {
  repo: RepoRef;
  /** PR to open first; omitted when started with just a repo (the UI lists open PRs). */
  pr?: number;
  provider?: ProviderId;
  model?: string;
  port?: number;
  open: boolean;
  debug: boolean;
  /** Read .review-dash.yaml and REVIEW.md at the PR head instead of the base commit. */
  trustPrConfig: boolean;
}

export const USAGE = `Usage: review-dash <owner/repo#123 | https://github.com/owner/repo/pull/123> [options]
       review-dash <owner/repo | https://github.com/owner/repo> [options]

With only a repository, the UI lists its open pull requests to choose from.

Options:
  --provider <name>  LLM provider: claude-cli | codex-cli | openrouter
  --model <name>     LLM model
  --port <n>         Port to listen on (default: random free port)
  --no-open          Do not open the browser
  --trust-pr-config  Use the PR's own .review-dash.yaml and REVIEW.md (default: the base
                     branch's, since a PR could change its own review rules)
  --debug            Verbose logging
  -h, --help         Show this help`;

export class UsageError extends Error {}

export function parseCli(argv: string[]): CliOptions | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: 'string' },
        model: { type: 'string' },
        port: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        'trust-pr-config': { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return 'help';

  if (positionals.length !== 1) {
    throw new UsageError('Expected exactly one PR or repository reference.');
  }
  const arg = positionals[0]!;
  const pr = parsePrRef(arg);
  const repo = pr ? { owner: pr.owner, repo: pr.repo } : parseRepoRef(arg);
  if (!repo) throw new UsageError(`Invalid PR or repository reference: ${arg}`);

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(`Invalid port: ${values.port}`);
    }
  }

  if (values.provider !== undefined && !isProviderId(values.provider)) {
    throw new UsageError(
      `Invalid provider: ${values.provider} (expected one of ${PROVIDER_IDS.join(', ')})`,
    );
  }

  return {
    repo,
    ...(pr ? { pr: pr.number } : {}),
    provider: values.provider as ProviderId | undefined,
    model: values.model,
    port,
    open: !values['no-open'],
    debug: values.debug,
    trustPrConfig: values['trust-pr-config'],
  };
}
