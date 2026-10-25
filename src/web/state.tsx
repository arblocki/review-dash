import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, jsonBody } from './api';
import { sourceLines } from './lib/diffModel';
import { createDraftSync, type UnsyncedDraft } from './lib/draftSync';
import type {
  Draft,
  LineRange,
  LocalDraft,
  PrMeta,
  Incomplete,
  PrResponse,
  ParsedFile,
  ReviewThread,
  SessionInfo,
  Side,
} from './types';

export type ViewType = 'unified' | 'split';

function usePersistentState<T extends string | boolean>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`review-dash:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(`review-dash:${key}`, JSON.stringify(next));
      } catch {
        // storage unavailable: setting just won't persist
      }
    },
    [key],
  );
  return [value, set] as const;
}

export interface ReviewContextValue {
  session: SessionInfo;
  pr: PrMeta;
  files: ParsedFile[];
  viewer: string;
  isSelfReview: boolean;
  incomplete?: Incomplete;
  threads: ReviewThread[];
  threadsError: string | null;
  viewType: ViewType;
  setViewType(v: ViewType): void;
  hideWhitespace: boolean;
  setHideWhitespace(v: boolean): void;
  refreshing: boolean;
  refresh(): Promise<void>;
  /** Why the last manual refresh failed (existing data is kept); cleared by the next success. */
  refreshError: string | null;
  dismissRefreshError(): void;
  /** Lines of a file at a ref (cached). */
  fetchFile(path: string, ref: string): Promise<string[]>;
  /** Creates an empty local draft and returns its id. Nothing is saved until it has text. */
  startDraft(input: { path: string; range: LineRange; hunkId?: string }): string;
  updateDraftBody(id: string, body: string): void;
  deleteDraft(id: string): Promise<void>;
  /**
   * Syncs every draft with the server now (called before submitting). Resolves with the drafts
   * the server still doesn't match; non-empty means a submit would send stale comments.
   */
  flushDrafts(): Promise<UnsyncedDraft[]>;
  /** Re-reads drafts and threads from the server (after a submit). */
  reloadAfterSubmit(): Promise<void>;
  replyToThread(thread: ReviewThread, body: string): Promise<void>;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);
const DraftsContext = createContext<LocalDraft[]>([]);

export function useReview(): ReviewContextValue {
  const v = useContext(ReviewContext);
  if (!v) throw new Error('useReview outside ReviewProvider');
  return v;
}

export function useDrafts(): LocalDraft[] {
  return useContext(DraftsContext);
}

/** Drafts that have text, i.e. what a submit would include. */
export function useDraftCount(): number {
  return useDrafts().filter((d) => d.body.trim()).length;
}

export function useDraft(id: string): LocalDraft | undefined {
  return useDrafts().find((d) => d.id === id);
}

export interface DraftAnchor {
  id: string;
  side: Side;
  line: number;
  startLine?: number;
  startSide?: Side;
}

/**
 * Where a file's drafts sit. The array identity only changes when an anchor changes (not on
 * every keystroke), so heavy diff components can depend on it.
 */
export function useFileDraftAnchors(path: string): DraftAnchor[] {
  const drafts = useDrafts();
  const mine = drafts.filter((d) => d.path === path);
  const signature = mine
    .map((d) => `${d.id}:${d.side}:${d.line}:${d.startSide ?? ''}:${d.startLine ?? ''}`)
    .join('|');
  // Deliberately keyed on the signature, not on `mine`.
  return useMemo(
    () =>
      mine.map((d) => ({
        id: d.id,
        side: d.side,
        line: d.line,
        startLine: d.startLine,
        startSide: d.startSide,
      })),
    [signature],
  );
}

type Loaded = {
  session: SessionInfo;
  data: PrResponse;
};

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [drafts, setDraftsState] = useState<LocalDraft[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [viewType, setViewType] = usePersistentState<ViewType>('viewType', 'unified');
  const [hideWhitespace, setHideWhitespace] = usePersistentState('hideWhitespace', false);

  // Drafts live in a ref so autosave callbacks always see the latest text.
  const draftsRef = useRef<LocalDraft[]>([]);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
  const fileCache = useRef(new Map<string, Promise<string[]>>());

  const mutateDrafts = useCallback((fn: (d: LocalDraft[]) => LocalDraft[]) => {
    draftsRef.current = fn(draftsRef.current);
    setDraftsState(draftsRef.current);
  }, []);
  const sync = useMemo(
    () => createDraftSync(api, { get: () => draftsRef.current, update: mutateDrafts }),
    [mutateDrafts],
  );

  const loadThreads = useCallback(async () => {
    try {
      const res = await api<{ threads: ReviewThread[] }>('/api/threads');
      setThreads(res.threads);
      setThreadsError(null);
    } catch (err) {
      setThreadsError((err as Error).message);
    }
  }, []);

  const loadDrafts = useCallback(async () => {
    const res = await api<{ drafts: Draft[] }>('/api/drafts');
    const server: LocalDraft[] = res.drafts.map((d) => {
      const local: LocalDraft & { updatedAt?: string } = { ...d, status: 'saved', persisted: true };
      delete local.updatedAt;
      return local;
    });
    // Keep local drafts that the server doesn't know yet (or that are mid-edit).
    mutateDrafts((local) => {
      const keep = local.filter((d) => d.status !== 'saved' || !d.persisted);
      const keepIds = new Set(keep.map((d) => d.id));
      return [...server.filter((d) => !keepIds.has(d.id)), ...keep];
    });
  }, [mutateDrafts]);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [session, data] = await Promise.all([
        api<SessionInfo>('/api/session'),
        api<PrResponse>('/api/pr'),
        loadThreads(),
        loadDrafts(),
      ]).then(([s, d]) => [s, d] as const);
      setLoaded({ session, data });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadThreads, loadDrafts]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [data] = await Promise.all([api<PrResponse>('/api/pr?refresh=1'), loadThreads()]);
      fileCache.current.clear();
      setLoaded((l) => (l ? { ...l, data } : l));
      setRefreshError(null);
    } catch (err) {
      setRefreshError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [loadThreads]);

  const dismissRefreshError = useCallback(() => setRefreshError(null), []);

  const fetchFile = useCallback((path: string, ref: string) => {
    const key = `${ref}:${path}`;
    let p = fileCache.current.get(key);
    if (!p) {
      p = api<{ content: string }>(
        `/api/file?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`,
      ).then((r) => sourceLines(r.content));
      fileCache.current.set(key, p);
      p.catch(() => fileCache.current.delete(key));
    }
    return p;
  }, []);

  // --- drafts ---------------------------------------------------------------------------

  const startDraft = useCallback<ReviewContextValue['startDraft']>(
    ({ path, range, hunkId }) => {
      // Re-clicking a line that already has an empty composer reuses it.
      const same = draftsRef.current.find(
        (d) =>
          d.path === path &&
          d.side === range.side &&
          d.line === range.line &&
          d.startLine === range.startLine &&
          !d.body.trim(),
      );
      if (same) return same.id;
      const id = crypto.randomUUID();
      const headSha = loadedRef.current?.data.pr.headSha ?? '';
      const draft: LocalDraft = {
        id,
        path,
        side: range.side,
        line: range.line,
        ...(range.startLine !== undefined
          ? { startLine: range.startLine, startSide: range.startSide ?? range.side }
          : {}),
        ...(hunkId ? { hunkId } : {}),
        body: '',
        headSha,
        status: 'new',
        persisted: false,
      };
      mutateDrafts((ds) => [...ds, draft]);
      return id;
    },
    [mutateDrafts],
  );

  const { updateBody: updateDraftBody, remove: deleteDraft, flush: flushDrafts } = sync;

  const reloadAfterSubmit = useCallback(async () => {
    // Submitted drafts are deleted server-side; drop local copies that are now gone.
    mutateDrafts((ds) => ds.filter((d) => !d.persisted));
    await Promise.all([loadDrafts(), loadThreads()]);
  }, [mutateDrafts, loadDrafts, loadThreads]);

  const replyToThread = useCallback<ReviewContextValue['replyToThread']>(async (thread, body) => {
    const root = thread.comments[0]?.databaseId;
    if (!root) throw new Error('This thread cannot be replied to from here.');
    const res = await api<{ id: number; url: string }>(`/api/threads/${root}/replies`, {
      method: 'POST',
      ...jsonBody({ body }),
    });
    const viewer = loadedRef.current?.data.viewer ?? null;
    setThreads((ts) =>
      ts.map((t) =>
        t.id === thread.id
          ? {
              ...t,
              comments: [
                ...t.comments,
                {
                  id: `local-${res.id}`,
                  databaseId: res.id,
                  author: viewer,
                  body,
                  createdAt: new Date().toISOString(),
                  url: res.url,
                },
              ],
            }
          : t,
      ),
    );
  }, []);

  useEffect(() => () => sync.dispose(), [sync]);

  const value = useMemo<ReviewContextValue | null>(
    () =>
      loaded && {
        session: loaded.session,
        pr: loaded.data.pr,
        files: loaded.data.files,
        viewer: loaded.data.viewer,
        isSelfReview: loaded.data.isSelfReview,
        incomplete: loaded.data.incomplete,
        threads,
        threadsError,
        viewType,
        setViewType,
        hideWhitespace,
        setHideWhitespace,
        refreshing,
        refresh,
        refreshError,
        dismissRefreshError,
        fetchFile,
        startDraft,
        updateDraftBody,
        deleteDraft,
        flushDrafts,
        reloadAfterSubmit,
        replyToThread,
      },
    [
      loaded,
      threads,
      threadsError,
      viewType,
      setViewType,
      hideWhitespace,
      setHideWhitespace,
      refreshing,
      refresh,
      refreshError,
      dismissRefreshError,
      fetchFile,
      startDraft,
      updateDraftBody,
      deleteDraft,
      flushDrafts,
      reloadAfterSubmit,
      replyToThread,
    ],
  );

  if (error) {
    return (
      <div className="mx-auto max-w-xl p-8">
        <p className="text-red-600 dark:text-red-400">Failed to load: {error}</p>
        <button
          type="button"
          className="mt-3 rounded border border-gray-300 px-3 py-1 text-sm dark:border-gray-600"
          onClick={() => void loadAll()}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!value) {
    return <p className="p-8 text-gray-500 dark:text-gray-400">Loading pull request…</p>;
  }
  return (
    <ReviewContext.Provider value={value}>
      <DraftsContext.Provider value={drafts}>{children}</DraftsContext.Provider>
    </ReviewContext.Provider>
  );
}
