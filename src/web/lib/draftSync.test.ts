import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import type { LocalDraft } from '../types';
import { createDraftSync, needsSync } from './draftSync';
import { runSubmit } from './submitFlow';

/** In-memory stand-in for the draft/review routes of the local server. */
function fakeServer() {
  const store = new Map<string, { id: string; body: string }>();
  const calls: string[] = [];
  const fail = { put: false, delete: 0 as 0 | 500 | 404 };
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (method === 'PUT' && path === '/drafts') {
      if (fail.put) throw new ApiError(500, 'boom');
      const d = JSON.parse(String(init.body)) as { id: string; body: string };
      store.set(d.id, { id: d.id, body: d.body });
      return { draft: d } as T;
    }
    if (method === 'DELETE' && path.startsWith('/drafts/')) {
      if (fail.delete === 500) throw new ApiError(500, 'boom');
      const id = decodeURIComponent(path.slice('/drafts/'.length));
      // A 404 still means the draft is gone from the server.
      if (fail.delete === 404 || !store.delete(id)) throw new ApiError(404, 'draft not found');
      return { ok: true } as T;
    }
    if (method === 'POST' && path === '/api/review') {
      return { submitted: [...store.values()].map((d) => d.body) } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, store, calls, fail };
}

function setup() {
  const server = fakeServer();
  let drafts: LocalDraft[] = [];
  const sync = createDraftSync(
    server.api,
    { get: () => drafts, update: (fn) => (drafts = fn(drafts)) },
    { autosaveMs: 1_000_000 },
  );
  const add = (id: string, body = ''): void => {
    drafts = [
      ...drafts,
      {
        id,
        path: 'src/a.ts',
        side: 'RIGHT',
        line: 7,
        body,
        headSha: 'abc',
        status: 'new',
        persisted: false,
        outdated: false,
      },
    ];
  };
  const submit = () =>
    runSubmit({
      flush: sync.flush,
      post: () => server.api<{ submitted: string[] }>('/api/review', { method: 'POST' }),
      reload: async () => undefined,
    });
  return { server, sync, add, submit, get: () => drafts };
}

describe('draft sync', () => {
  it('(a) a failed autosave of an edit blocks submission', async () => {
    const t = setup();
    t.add('d1');
    t.sync.updateBody('d1', 'Looks good');
    expect(await t.sync.flush()).toEqual([]);
    expect(t.server.store.get('d1')?.body).toBe('Looks good');

    t.sync.updateBody('d1', 'This needs fixing');
    t.server.fail.put = true;
    const failed = await t.sync.flush();
    expect(failed).toMatchObject([{ id: 'd1', path: 'src/a.ts', line: 7 }]);
    expect(t.get()[0]?.status).toBe('error');

    const outcome = await t.submit();
    expect(outcome.kind).toBe('unsynced');
    expect(t.server.calls).not.toContain('POST /api/review');
    // The server still has the old text; it must never be submitted as if current.
    expect(t.server.store.get('d1')?.body).toBe('Looks good');

    t.server.fail.put = false;
    const retried = await t.submit();
    expect(retried).toEqual({ kind: 'submitted', result: { submitted: ['This needs fixing'] } });
    t.sync.dispose();
  });

  it('(b) clearing a saved draft deletes it on the server', async () => {
    const t = setup();
    t.add('d1');
    t.sync.updateBody('d1', 'Please add a test');
    await t.sync.flush();
    expect(t.server.store.size).toBe(1);

    t.sync.updateBody('d1', '');
    expect(await t.sync.flush()).toEqual([]);
    expect(t.server.calls).toContain('DELETE /drafts/d1');
    expect(t.server.store.size).toBe(0);
    expect(t.get().filter(needsSync)).toEqual([]);
    expect(t.get()[0]?.persisted).toBe(false);

    const outcome = await t.submit();
    expect(outcome).toEqual({ kind: 'submitted', result: { submitted: [] } });
    t.sync.dispose();
  });

  it('keeps a cleared, never-saved draft local-only', async () => {
    const t = setup();
    t.add('d1');
    t.sync.updateBody('d1', '');
    expect(await t.sync.flush()).toEqual([]);
    expect(t.server.calls).toEqual([]);
    t.sync.dispose();
  });

  it('(b) clearing whose DELETE fails stays unsynced and blocks submit', async () => {
    const t = setup();
    t.add('d1');
    t.sync.updateBody('d1', 'text');
    await t.sync.flush();
    t.sync.updateBody('d1', '');
    t.server.fail.delete = 500;
    expect(await t.sync.flush()).toHaveLength(1);
    expect((await t.submit()).kind).toBe('unsynced');
    t.sync.dispose();
  });

  it('(c) a failed DELETE (500) keeps the draft locally as unsynced', async () => {
    const t = setup();
    t.add('d1');
    t.sync.updateBody('d1', 'text');
    await t.sync.flush();

    t.server.fail.delete = 500;
    await t.sync.remove('d1');
    const [d] = t.get();
    expect(d).toMatchObject({ id: 'd1', body: 'text', status: 'error', persisted: true });
    expect(d?.error).toMatch(/delete/i);
    expect(t.sync.unsynced().map((u) => u.id)).toEqual(['d1']);
    expect((await t.submit()).kind).toBe('unsynced');
    expect(t.server.calls).not.toContain('POST /api/review');

    // The retry deletes it again (it must not be re-saved) once the server recovers.
    t.server.fail.delete = 0;
    expect(await t.sync.flush()).toEqual([]);
    expect(t.get()).toEqual([]);
    expect(t.server.store.size).toBe(0);
    expect(t.server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
    t.sync.dispose();
  });

  it('(d) a 404 on DELETE counts as deleted', async () => {
    const t = setup();
    t.add('d1');
    t.sync.updateBody('d1', 'text');
    await t.sync.flush();

    t.server.fail.delete = 404;
    await t.sync.remove('d1');
    expect(t.get()).toEqual([]);
    expect(t.sync.unsynced()).toEqual([]);
    t.sync.dispose();
  });
});
