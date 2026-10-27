export const PROVIDER_IDS = ['claude-cli', 'codex-cli', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export interface LlmRequest {
  system: string;
  prompt: string;
  /** Structured output where the backend supports it. */
  jsonSchema?: object;
  /** Optional repo checkout for CLI agents to read. */
  cwd?: string;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface LlmResult {
  text: string;
  usage?: LlmUsage;
}

export interface LlmProvider {
  /** "claude-cli" | "codex-cli" | "openrouter" (or "fake" in tests). */
  id: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

export type LlmErrorKind =
  'not_installed' | 'auth' | 'timeout' | 'bad_output' | 'http' | 'aborted' | 'unsupported';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  constructor(
    kind: LlmErrorKind,
    message: string,
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'LlmError';
    this.kind = kind;
    this.status = opts.status;
  }
}
