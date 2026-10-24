import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider } from './fake.js';
import { completeJson, extractJson } from './json.js';

describe('extractJson', () => {
  it('handles plain, fenced, and prose-wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go:\n{"a":{"b":"}"}} hope that helps')).toEqual({
      a: { b: '}' },
    });
    expect(extractJson('result: [1,2,3]')).toEqual([1, 2, 3]);
  });
  it('throws bad_output when there is no JSON', () => {
    expect(() => extractJson('nothing here')).toThrow(
      expect.objectContaining({ kind: 'bad_output' }),
    );
    expect(() => extractJson('{"a":')).toThrow(expect.objectContaining({ kind: 'bad_output' }));
  });
});

describe('completeJson', () => {
  const schema = z.object({ n: z.number() });
  const req = { system: 's', prompt: 'give n' };

  it('retries once with the error appended, then succeeds', async () => {
    const p = new FakeProvider([
      { text: 'oops', usage: { inputTokens: 1, costUsd: 0.1 } },
      { text: '```json\n{"n":2}\n```', usage: { inputTokens: 2, costUsd: 0.2 } },
    ]);
    const res = await completeJson(p, req, schema);
    expect(res.value).toEqual({ n: 2 });
    expect(p.requests).toHaveLength(2);
    expect(p.requests[0]!.prompt).toBe('give n');
    expect(p.requests[1]!.prompt).toContain('previous reply was invalid');
    expect(res.usage).toMatchObject({ inputTokens: 3 });
    expect(res.usage?.costUsd).toBeCloseTo(0.3);
  });

  it('retries on schema mismatch and mentions the field', async () => {
    const p = new FakeProvider(['{"n":"x"}', '{"n":1}']);
    await completeJson(p, req, schema);
    expect(p.requests[1]!.prompt).toContain('n:');
  });

  it('throws bad_output after two broken replies', async () => {
    const p = new FakeProvider(['nope', '{"n":"still wrong"}']);
    await expect(completeJson(p, req, schema)).rejects.toMatchObject({ kind: 'bad_output' });
    expect(p.requests).toHaveLength(2);
  });

  it('does not retry provider errors', async () => {
    const p = new FakeProvider([new Error('boom'), '{"n":1}']);
    await expect(completeJson(p, req, schema)).rejects.toThrow('boom');
    expect(p.requests).toHaveLength(1);
  });
});
