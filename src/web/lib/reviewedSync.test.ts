import { describe, expect, it } from 'vitest';
import { createReviewedSync } from './reviewedSync';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake server that applies each request when it is actually sent. */
function setup() {
  const server = new Set<string>();
  const errors: unknown[] = [];
  const sent: string[] = [];
  let ui: ReadonlySet<string> = new Set();
  const sync = createReviewedSync({ onChange: (s) => (ui = s), onError: (e) => errors.push(e) });
  const req = (ids: string[], reviewed: boolean, gate?: Promise<void>, fail?: unknown) => () =>
    (gate ?? Promise.resolve()).then(() => {
      sent.push(`${reviewed ? 'mark' : 'unmark'} ${ids.join(',')}`);
      if (fail) throw fail;
      for (const id of ids) {
        if (reviewed) server.add(id);
        else server.delete(id);
      }
    });
  return { sync, server, errors, sent, ui: () => ui, req };
}

describe('createReviewedSync', () => {
  it('applies changes optimistically', () => {
    const t = setup();
    void t.sync.setItems(['a'], true, t.req(['a'], true, new Promise(() => undefined)));
    expect([...t.ui()]).toEqual(['a']);
    expect(t.sync.current().has('a')).toBe(true);
  });

  it('keeps mark-then-unmark ordered even when the first request is slow', async () => {
    const t = setup();
    const slow = deferred();
    const p1 = t.sync.setItems(['x'], true, t.req(['x'], true, slow.promise));
    const p2 = t.sync.setItems(['x'], false, t.req(['x'], false));
    expect(t.ui().has('x')).toBe(false);
    // The second request must not be sent until the first has finished.
    await Promise.resolve();
    expect(t.sent).toEqual([]);
    slow.resolve();
    await Promise.all([p1, p2]);
    expect(t.sent).toEqual(['mark x', 'unmark x']);
    expect(t.server.has('x')).toBe(false);
    expect(t.ui().has('x')).toBe(false);
  });

  it('does not let an error on an older request overwrite a newer successful toggle', async () => {
    const t = setup();
    const p1 = t.sync.setItems(['x'], true, t.req(['x'], true, undefined, new Error('boom')));
    const p2 = t.sync.setItems(['x'], false, t.req(['x'], false));
    // A third toggle after the first error is still the newest.
    const p3 = t.sync.setItems(['x'], true, t.req(['x'], true));
    await Promise.all([p1, p2, p3]);
    expect(t.errors).toHaveLength(1);
    expect(t.server.has('x')).toBe(true);
    expect(t.ui().has('x')).toBe(true);
  });

  it('rolls back only the failed item to its confirmed value', async () => {
    const t = setup();
    await t.sync.setItems(['a'], true, t.req(['a'], true));
    const p = t.sync.setItems(
      ['a', 'b'],
      false,
      t.req(['a', 'b'], false, undefined, new Error('x')),
    );
    const q = t.sync.setItems(['c'], true, t.req(['c'], true));
    await Promise.all([p, q]);
    expect([...t.ui()].sort()).toEqual(['a', 'c']);
    expect([...t.server].sort()).toEqual(['a', 'c']);
  });

  it('two failed toggles end at the server value, not the intermediate optimistic one', async () => {
    const t = setup();
    const p1 = t.sync.setItems(['x'], true, t.req(['x'], true, undefined, new Error('1')));
    const p2 = t.sync.setItems(['x'], false, t.req(['x'], false, undefined, new Error('2')));
    await Promise.all([p1, p2]);
    expect(t.server.has('x')).toBe(false);
    expect(t.ui().has('x')).toBe(false);
    expect(t.errors).toHaveLength(2);
  });

  it('rolls back an unmark that failed', async () => {
    const t = setup();
    await t.sync.setItems(['x'], true, t.req(['x'], true));
    await t.sync.setItems(['x'], false, t.req(['x'], false, undefined, new Error('x')));
    expect(t.ui().has('x')).toBe(true);
    expect(t.server.has('x')).toBe(true);
  });

  describe('applySnapshot', () => {
    it('does not resurrect an item unchecked before the snapshot arrived', async () => {
      const t = setup();
      t.server.add('x');
      t.server.add('y');
      // The user unchecks x while the initial GET is still pending (x looked unchecked locally).
      const p = t.sync.setItems(['x'], false, t.req(['x'], false));
      t.sync.applySnapshot(['x', 'y']);
      expect([...t.ui()]).toEqual(['y']);
      await p;
      expect(t.server.has('x')).toBe(false);
    });

    it('keeps a locally checked item and takes server values for untouched ones', () => {
      const t = setup();
      void t.sync.setItems(['n'], true, t.req(['n'], true, new Promise(() => undefined)));
      t.sync.applySnapshot(['y']);
      expect([...t.ui()].sort()).toEqual(['n', 'y']);
    });

    it('rolls a touched item back to the server value when its save fails', async () => {
      const t = setup();
      t.server.add('x');
      const p = t.sync.setItems(['x'], false, t.req(['x'], false, undefined, new Error('x')));
      t.sync.applySnapshot(['x']);
      await p;
      expect(t.ui().has('x')).toBe(true);
    });
  });
});
