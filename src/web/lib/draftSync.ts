import type { Draft, LocalDraft } from '../types';

export const AUTOSAVE_MS = 700;

/** Calls the API of the PR under review; `path` is relative to it (`/drafts`). */
type ApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Where the drafts live; state.tsx backs this with a ref plus React state. */
export interface DraftStore {
  get(): LocalDraft[];
  update(fn: (drafts: LocalDraft[]) => LocalDraft[]): void;
}

/** A draft whose latest local content the server has not confirmed. */
export interface UnsyncedDraft {
  id: string;
  path: string;
  line: number;
  startLine?: number;
  message: string;
}

/**
 * What the server must hold for a draft to match the UI: a draft with text must be saved with
 * that text; a cleared or deleted draft must not exist there. Never-persisted empty drafts are local-only.
 */
export function needsSync(d: LocalDraft): boolean {
  if (d.pendingDelete) return true;
  return d.body.trim() ? d.status !== 'saved' : d.persisted;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isNotFound = (err: unknown) => (err as { status?: unknown })?.status === 404;

/** Autosave / delete logic for drafts, independent of React so it can be tested directly. */
export function createDraftSync(api: ApiFn, store: DraftStore, opts: { autosaveMs?: number } = {}) {
  const autosaveMs = opts.autosaveMs ?? AUTOSAVE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, Promise<void>>();

  const find = (id: string) => store.get().find((x) => x.id === id);
  const patch = (id: string, p: Partial<LocalDraft>) =>
    store.update((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)));
  const clearTimer = (id: string) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  };
  const schedule = (id: string) => {
    clearTimer(id);
    timers.set(
      id,
      setTimeout(() => void save(id), autosaveMs),
    );
  };

  /** Makes the server match this draft: PUT its text, or DELETE it once the text is cleared. */
  async function save(id: string): Promise<void> {
    clearTimer(id);
    // Serialize requests per draft so an older body can't land after a newer one.
    const previous = inflight.get(id);
    if (previous) await previous.catch(() => undefined);

    const d = find(id);
    if (!d) return;
    const clearing = d.pendingDelete || !d.body.trim();
    if (clearing && !d.persisted) return; // never saved: stays local-only
    const sent = d.body;
    patch(id, { status: 'saving', error: undefined });
    const run = (async () => {
      try {
        if (clearing) {
          try {
            await api(`/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
          } catch (err) {
            if (!isNotFound(err)) throw err;
          }
          if (d.pendingDelete) {
            store.update((ds) => ds.filter((x) => x.id !== id));
            return;
          }
          const cur = find(id);
          if (cur) patch(id, { persisted: false, status: cur.body === sent ? 'new' : 'dirty' });
          return;
        }
        await api<{ draft: Draft }>('/drafts', {
          method: 'PUT',
          body: JSON.stringify({
            id,
            path: d.path,
            side: d.side,
            line: d.line,
            startLine: d.startLine,
            startSide: d.startSide,
            body: sent,
            hunkId: d.hunkId,
            headSha: d.headSha,
          }),
        });
        const cur = find(id);
        if (cur) patch(id, { persisted: true, status: cur.body === sent ? 'saved' : 'dirty' });
      } catch (err) {
        if (find(id)) patch(id, { status: 'error', error: messageOf(err) });
      }
    })();
    inflight.set(id, run);
    await run;
    if (inflight.get(id) === run) inflight.delete(id);
    // Text typed while the request was in flight still needs saving.
    if (find(id)?.status === 'dirty') schedule(id);
  }

  function updateBody(id: string, body: string): void {
    patch(id, { body, status: 'dirty', pendingDelete: undefined });
    schedule(id);
  }

  /** Removes the draft locally, then on the server. A failed DELETE keeps it, marked unsynced. */
  async function remove(id: string): Promise<void> {
    clearTimer(id);
    const d = find(id);
    const pending = inflight.get(id);
    store.update((ds) => ds.filter((x) => x.id !== id));
    if (pending) await pending.catch(() => undefined);
    if (!d || !(d.persisted || pending)) return;
    try {
      await api(`/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      if (isNotFound(err)) return; // already gone
      const body = find(id)?.body ?? d.body;
      store.update((ds) =>
        ds.some((x) => x.id === id)
          ? ds
          : [
              ...ds,
              {
                ...d,
                body,
                persisted: true,
                pendingDelete: true,
                status: 'error',
                error: `Could not delete this draft on the server: ${messageOf(err)}`,
              },
            ],
      );
    }
  }

  const unsynced = (): UnsyncedDraft[] =>
    store
      .get()
      .filter(needsSync)
      .map((d) => ({
        id: d.id,
        path: d.path,
        line: d.line,
        ...(d.startLine !== undefined ? { startLine: d.startLine } : {}),
        message: d.error ?? (d.status === 'error' ? 'Save failed' : 'Not saved'),
      }));

  /**
   * Brings the server in line with every draft. Resolves with the drafts that are still not
   * confirmed there (empty when everything is in sync): callers must not submit if non-empty.
   */
  async function flush(): Promise<UnsyncedDraft[]> {
    for (let round = 0; round < 3; round++) {
      const ids = store
        .get()
        .filter(needsSync)
        .map((d) => d.id);
      await Promise.all([
        ...ids.map((id) => save(id)),
        ...[...inflight.values()].map((p) => p.catch(() => undefined)),
      ]);
      // Retry only if text changed mid-flush; failures are reported rather than looped on.
      if (!store.get().some((d) => needsSync(d) && d.status !== 'error')) break;
    }
    return unsynced();
  }

  function dispose(): void {
    timers.forEach(clearTimeout);
    timers.clear();
  }

  return { save, updateBody, remove, flush, dispose, unsynced };
}

export type DraftSync = ReturnType<typeof createDraftSync>;
