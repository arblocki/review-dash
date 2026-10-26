import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from './types.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

const UNSUPPORTED_FORMAT_RE = /response_format|json_schema|structured output|structured_outputs/i;

export class OpenRouterProvider implements LlmProvider {
  readonly id = 'openrouter';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenRouterOptions) {
    if (!opts.apiKey) throw new LlmError('auth', 'OPENROUTER_API_KEY is empty');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const first = await this.post(req, true);
    if (first.ok) return parseSuccess(first.json);
    if (req.jsonSchema && first.status === 400 && UNSUPPORTED_FORMAT_RE.test(first.errorText)) {
      const retry = await this.post(req, false);
      if (retry.ok) return parseSuccess(retry.json);
      throw httpError(retry);
    }
    throw httpError(first);
  }

  private async post(req: LlmRequest, withFormat: boolean) {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
      usage: { include: true },
    };
    if (withFormat && req.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', strict: true, schema: req.jsonSchema },
      };
    }

    const timeoutMs = this.opts.timeoutMs ?? 5 * 60_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url ?? OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'review-dash',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw this.classify(err, req.signal, timeout, timeoutMs, 'request failed');
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      throw this.classify(err, req.signal, timeout, timeoutMs, 'failed to read response body');
    }
    let json: unknown;
    try {
      json = raw ? JSON.parse(raw) : undefined;
    } catch {
      json = undefined;
    }
    const errObj = (json as { error?: { message?: unknown } } | undefined)?.error;
    if (res.ok && !errObj) return { ok: true as const, status: res.status, json, errorText: '' };
    const errorText =
      (typeof errObj?.message === 'string' ? errObj.message : '') ||
      raw.slice(0, 500) ||
      res.statusText;
    return { ok: false as const, status: res.ok ? 502 : res.status, json, errorText };
  }

  /** Map a fetch()/body-read failure to user abort, timeout, or a generic http error. */
  private classify(
    err: unknown,
    userSignal: AbortSignal | undefined,
    timeout: AbortSignal,
    timeoutMs: number,
    what: string,
  ): LlmError {
    if (userSignal?.aborted)
      return new LlmError('aborted', 'OpenRouter request aborted', { cause: err });
    if (timeout.aborted)
      return new LlmError('timeout', `OpenRouter timed out after ${timeoutMs}ms`, { cause: err });
    return new LlmError('http', `OpenRouter ${what}: ${(err as Error).message}`, { cause: err });
  }
}

function httpError(r: { status: number; errorText: string }): LlmError {
  const kind = r.status === 401 || r.status === 403 ? 'auth' : 'http';
  return new LlmError(kind, `OpenRouter error ${r.status}: ${r.errorText}`, { status: r.status });
}

function parseSuccess(json: unknown): LlmResult {
  const j = json as
    | {
        choices?: { message?: { content?: unknown } }[];
        usage?: Record<string, unknown>;
      }
    | undefined;
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content === '') {
    throw new LlmError('bad_output', 'OpenRouter response has no message content');
  }
  const usage: LlmUsage = {};
  const u = j?.usage;
  if (u) {
    if (typeof u.prompt_tokens === 'number') usage.inputTokens = u.prompt_tokens;
    if (typeof u.completion_tokens === 'number') usage.outputTokens = u.completion_tokens;
    if (typeof u.cost === 'number') usage.costUsd = u.cost;
  }
  return Object.keys(usage).length ? { text: content, usage } : { text: content };
}
