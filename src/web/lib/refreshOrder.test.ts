import { describe, expect, it } from 'vitest';
import { refreshInOrder } from './refreshOrder';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('refreshInOrder', () => {
  it('reads drafts only after the PR refresh has completed, even if drafts would be faster', async () => {
    const calls: string[] = [];
    const pr = deferred<string>();
    const p = refreshInOrder({
      fetchPr: () => {
        calls.push('pr:start');
        return pr.promise.then((v) => (calls.push('pr:end'), v));
      },
      loadThreads: async () => void calls.push('threads'),
      loadDrafts: async () => void calls.push('drafts'),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['threads', 'pr:start']);
    pr.resolve('data');
    expect(await p).toBe('data');
    expect(calls).toEqual(['threads', 'pr:start', 'pr:end', 'drafts']);
  });

  it('does not load drafts when the PR refresh fails', async () => {
    const calls: string[] = [];
    await expect(
      refreshInOrder({
        fetchPr: () => Promise.reject(new Error('down')),
        loadThreads: async () => void calls.push('threads'),
        loadDrafts: async () => void calls.push('drafts'),
      }),
    ).rejects.toThrow('down');
    expect(calls).toEqual(['threads']);
  });
});
