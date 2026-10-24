import type { z } from 'zod';
import { LlmError, type LlmProvider, type LlmRequest, type LlmUsage } from './types.js';

/** Extract the first JSON value from model output, tolerating fences and prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (let m = fence.exec(trimmed); m; m = fence.exec(trimmed)) candidates.push(m[1]!.trim());
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  // Leading/trailing prose: scan for a balanced object/array.
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(trimmed, i);
    if (end < 0) continue;
    try {
      return JSON.parse(trimmed.slice(i, end + 1));
    } catch {
      /* keep scanning */
    }
  }
  throw new LlmError('bad_output', 'No valid JSON found in model output');
}

function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface CompleteJsonResult<T> {
  value: T;
  text: string;
  usage?: LlmUsage;
}

function addUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    costUsd: sum(a.costUsd, b.costUsd),
  };
}

/**
 * Call the provider, parse JSON and validate with zod. On failure, retry (default once)
 * with the error appended to the prompt; then throw LlmError('bad_output').
 * Provider errors (auth, timeout, ...) are not retried here.
 */
export async function completeJson<T>(
  provider: LlmProvider,
  req: LlmRequest,
  schema: z.ZodType<T>,
  opts: { retries?: number } = {},
): Promise<CompleteJsonResult<T>> {
  const retries = opts.retries ?? 1;
  let current = req;
  let usage: LlmUsage | undefined;
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await provider.complete(current);
    usage = addUsage(usage, res.usage);
    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(res.text));
      if (parsed.success) return { value: parsed.data, text: res.text, usage };
      problem = `JSON did not match the schema:\n${parsed.error.issues
        .slice(0, 10)
        .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      problem = err.message;
    }
    lastError = problem;
    current = {
      ...req,
      prompt: `${req.prompt}\n\nYour previous reply was invalid: ${problem}\nReply again with ONLY valid JSON that matches the required schema.`,
    };
  }
  throw new LlmError(
    'bad_output',
    `Model output invalid after ${retries + 1} attempt(s): ${lastError}`,
  );
}
