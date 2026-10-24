import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from './openrouter.js';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(init.body as string) });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(init) : next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (content = '{"a":1}') =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 11, completion_tokens: 22, cost: 0.002 },
    }),
    { status: 200 },
  );
const err = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

describe('OpenRouterProvider', () => {
  it('sends the expected request and maps usage', async () => {
    const { impl, calls } = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'sk-secret', model: 'm/x', fetch: impl });
    const res = await p.complete({ system: 'SYS', prompt: 'P', jsonSchema: { type: 'object' } });
    expect(res).toEqual({
      text: '{"a":1}',
      usage: { inputTokens: 11, outputTokens: 22, costUsd: 0.002 },
    });
    const c = calls[0]!;
    expect(c.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    expect(c.body).toEqual({
      model: 'm/x',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'P' },
      ],
      usage: { include: true },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', strict: true, schema: { type: 'object' } },
      },
    });
  });

  it('retries once without response_format when unsupported', async () => {
    const { impl, calls } = fakeFetch([
      err(400, 'Provider does not support response_format json_schema'),
      ok(),
    ]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm', fetch: impl });
    const res = await p.complete({ system: 's', prompt: 'p', jsonSchema: {} });
    expect(res.text).toBe('{"a":1}');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.response_format).toBeDefined();
    expect(calls[1]!.body.response_format).toBeUndefined();
  });

  it('maps errors and does not leak the key', async () => {
    const mk = (r: Response) =>
      new OpenRouterProvider({ apiKey: 'sk-secret', model: 'm', fetch: fakeFetch([r]).impl });
    await expect(
      mk(err(401, 'bad key')).complete({ system: '', prompt: 'p' }),
    ).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
    const e = await mk(err(500, 'boom'))
      .complete({ system: '', prompt: 'p' })
      .catch((x: Error) => x);
    expect(e).toMatchObject({ kind: 'http' });
    expect((e as Error).message).not.toContain('sk-secret');
    await expect(
      mk(new Response(JSON.stringify({ choices: [] }), { status: 200 })).complete({
        system: '',
        prompt: 'p',
      }),
    ).rejects.toMatchObject({ kind: 'bad_output' });
  });

  it('honors abort and timeout', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const ac = new AbortController();
    const a = new OpenRouterProvider({ apiKey: 'k', model: 'm', fetch: fakeFetch([hang]).impl });
    const pending = a.complete({ system: '', prompt: 'p', signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });

    const t = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      timeoutMs: 20,
      fetch: fakeFetch([hang]).impl,
    });
    await expect(t.complete({ system: '', prompt: 'p' })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
