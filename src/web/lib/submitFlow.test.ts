import { describe, expect, it, vi } from 'vitest';
import { runSubmit } from './submitFlow';

const ok = { flush: async () => [] };

describe('runSubmit', () => {
  it('reports success with a refresh warning when only the reload fails', async () => {
    const post = vi.fn(async () => ({ reviewUrl: 'u' }));
    const outcome = await runSubmit({
      ...ok,
      post,
      reload: async () => {
        throw new Error('network down');
      },
    });
    expect(outcome).toEqual({
      kind: 'submitted',
      result: { reviewUrl: 'u' },
      refreshError: 'network down',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('reports plain success when the reload works', async () => {
    const outcome = await runSubmit({ ...ok, post: async () => 1, reload: async () => undefined });
    expect(outcome).toEqual({ kind: 'submitted', result: 1 });
  });

  it('propagates a failed POST without reloading', async () => {
    const reload = vi.fn(async () => undefined);
    await expect(
      runSubmit({
        ...ok,
        post: async () => {
          throw new Error('rejected');
        },
        reload,
      }),
    ).rejects.toThrow('rejected');
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not post while drafts are unsynced', async () => {
    const post = vi.fn(async () => 1);
    const failed = [{ id: 'd', path: 'a', line: 1, message: 'x' }];
    const outcome = await runSubmit({ flush: async () => failed, post, reload: async () => {} });
    expect(outcome).toEqual({ kind: 'unsynced', failed });
    expect(post).not.toHaveBeenCalled();
  });
});
