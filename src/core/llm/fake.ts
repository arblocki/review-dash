import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from './types.js';

export type FakeResponse = string | LlmResult | Error | ((req: LlmRequest) => string | LlmResult);

/** Returns scripted responses in order and records requests. For tests. */
export class FakeProvider implements LlmProvider {
  readonly id: string;
  readonly requests: LlmRequest[] = [];
  private readonly queue: FakeResponse[];

  constructor(responses: FakeResponse[], id = 'fake') {
    this.queue = [...responses];
    this.id = id;
  }

  get remaining(): number {
    return this.queue.length;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req);
    if (req.signal?.aborted) throw new LlmError('aborted', 'aborted');
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeProvider: no scripted responses left');
    if (next instanceof Error) throw next;
    const out = typeof next === 'function' ? next(req) : next;
    return typeof out === 'string' ? { text: out } : out;
  }
}
