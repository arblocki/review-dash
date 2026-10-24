import { parseArgs } from 'node:util';
import { isProviderId, PROVIDER_IDS, type ProviderId } from '../core/llm/types.js';
import { parsePrRef, type PrRef } from '../core/pr-ref.js';

export interface CliOptions {
  pr: PrRef;
  provider?: ProviderId;
  model?: string;
  port?: number;
  open: boolean;
  debug: boolean;
}

export const USAGE = `Usage: review-dash <owner/repo#123 | https://github.com/owner/repo/pull/123> [options]

Options:
  --provider <name>  LLM provider: claude-cli | codex-cli | openrouter
  --model <name>     LLM model
  --port <n>         Port to listen on (default: random free port)
  --no-open          Do not open the browser
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
        debug: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return 'help';

  if (positionals.length !== 1) throw new UsageError('Expected exactly one PR reference.');
  const pr = parsePrRef(positionals[0]!);
  if (!pr) throw new UsageError(`Invalid PR reference: ${positionals[0]}`);

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
    pr,
    provider: values.provider as ProviderId | undefined,
    model: values.model,
    port,
    open: !values['no-open'],
    debug: values.debug,
  };
}
