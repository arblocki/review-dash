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
import { useAnalysis } from './analysis';
import { api, jsonBody } from './api';
import { verifyIdsFromWire, verifyWireArgs } from './lib/groups';
import { filterSections } from './lib/reviewFilter';
import { fileKeyMap } from './lib/reviewItems';
import { reviewItemIds } from '../core/review-items';
import { createReviewedSync } from './lib/reviewedSync';
import { describeReviewedError } from './lib/reviewedError';
import type { DiffSection } from './lib/sections';
import { autoClearIds, hunkStatus, type HunkStatus } from './lib/progress';
import { effectiveHideReviewed, reReviewInfo, type ReReview } from './lib/rereview';
import { useReview } from './state';
import type { InterdiffResponse, ReviewStateResponse } from './types';

export interface ReviewStateValue {
  /** Hunks the user marked reviewed (server-backed). Auto-cleared hunks are not in here. */
  reviewed: ReadonlySet<string>;
  /** Every review item in the PR: hunk ids plus the keys of hunkless files. */
  knownItemIds: ReadonlySet<string>;
  /** path -> review-item key, for files without hunks. */
  fileKeys: ReadonlyMap<string, string>;
  /** The loaded analysis is for an older PR version: auto-clear is paused until it is replaced. */
  analysisStale: boolean;
  status(id: string): HunkStatus;
  /** Checks or unchecks one hunk. Checking an auto-cleared hunk stores real reviewed state. */
  toggleHunk(id: string): void;
  /** Marks (or unmarks) many hunks at once. */
  setHunks(ids: string[], reviewed: boolean): void;
  verifyChecked: ReadonlySet<string>;
  toggleVerify(id: string): void;
  interdiff: InterdiffResponse | null;
  reReview: ReReview | null;
  hideReviewed: boolean;
  setHideReviewed(v: boolean): void;
  /** Re-fetches the PR head from GitHub; resolves to the current head sha. */
  checkHead(): Promise<string | null>;
  /** Re-fetches interdiff (after submitting a review or moving the checkpoint). */
  reloadInterdiff(): Promise<void>;
  /** Moves the re-review baseline to the current head; the banner goes away. */
  markDoneReviewing(): Promise<void>;
  error: string | null;
  /** The error is a stale-head conflict: refreshing the PR is the fix. */
  errorNeedsRefresh: boolean;
  dismissError(): void;
}

const ReviewStateContext = createContext<ReviewStateValue | null>(null);

export function useReviewState(): ReviewStateValue {
  const v = useContext(ReviewStateContext);
  if (!v) throw new Error('useReviewState outside ReviewStateProvider');
  return v;
}

interface Focus {
  hunkId: string | null;
  setHunkId(id: string | null): void;
}
// Separate from the main context so moving focus only re-renders the hunk bars.
const FocusContext = createContext<Focus>({ hunkId: null, setHunkId: () => undefined });
export const useFocusedHunk = (): Focus => useContext(FocusContext);

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function saveSet(key: string, set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // storage unavailable: the override just won't survive a reload
  }
}

export function ReviewStateProvider({ children }: { children: ReactNode }) {
  const { session, files, pr, diffHash } = useReview();
  const { result, stale } = useAnalysis();
  const [reviewed, setReviewedState] = useState<ReadonlySet<string>>(new Set());
  const [errorState, setErrorState] = useState<{ message: string; needsRefresh: boolean } | null>(
    null,
  );
  const sync = useMemo(
    () =>
      createReviewedSync({
        onChange: setReviewedState,
        onError: (err) => setErrorState(describeReviewedError(err)),
      }),
    [],
  );
  const [verifyChecked, setVerifyChecked] = useState<ReadonlySet<string>>(new Set());
  const [interdiff, setInterdiff] = useState<InterdiffResponse | null>(null);
  const [hideChoice, setHideChoice] = useState<boolean | null>(null);
  const error = errorState?.message ?? null;
  const setError = useCallback(
    (message: string | null) => setErrorState(message ? { message, needsRefresh: false } : null),
    [],
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Auto-clear is never stored, so un-checking an auto-cleared hunk is a local override.
  const overrideKey = `review-dash:autoUnchecked:${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
  const [autoUnchecked, setAutoUnchecked] = useState<ReadonlySet<string>>(() =>
    loadSet(overrideKey),
  );

  const verifyRef = useRef(verifyChecked);
  verifyRef.current = verifyChecked;
  const uncheckedRef = useRef(autoUnchecked);
  uncheckedRef.current = autoUnchecked;

  const fileKeys = useMemo(() => fileKeyMap(files, pr.headSha), [files, pr.headSha]);
  const knownItemIds = useMemo(
    () => new Set(reviewItemIds(files, pr.headSha)),
    [files, pr.headSha],
  );
  const auto = useMemo(
    // A stale analysis describes an older diff: it must not auto-clear hunks of this one.
    () => (result && !stale ? autoClearIds(result.analysis.groups, fileKeys) : new Set<string>()),
    [result, stale, fileKeys],
  );
  const autoRef = useRef(auto);
  autoRef.current = auto;

  useEffect(() => {
    api<ReviewStateResponse>('/api/review-state').then(
      (s) => {
        // Local edits made before this arrived win.
        sync.applySnapshot(s.reviewedHunkIds);
        setVerifyChecked((cur) => new Set([...verifyIdsFromWire(s.verifyChecks), ...cur]));
      },
      (err: unknown) => setError(`Could not load reviewed state: ${(err as Error).message}`),
    );
  }, [setError, sync]);

  const reloadInterdiff = useCallback(async () => {
    try {
      setInterdiff(await api<InterdiffResponse>('/api/interdiff'));
    } catch {
      // the banner is optional; the diff still works without it
    }
  }, []);
  // On load, and again whenever a refresh brings in a new head.
  useEffect(() => {
    void reloadInterdiff();
  }, [reloadInterdiff, pr.headSha]);

  const checkHead = useCallback(async () => {
    try {
      const i = await api<InterdiffResponse>('/api/interdiff?refresh=1');
      setInterdiff(i);
      return i.currentHeadSha;
    } catch {
      return null;
    }
  }, []);

  const setHunks = useCallback(
    (ids: string[], value: boolean) => {
      sync.setItems(ids, value, () =>
        api('/api/reviewed', {
          method: 'PUT',
          ...jsonBody({ hunkIds: ids, reviewed: value, headSha: pr.headSha, diffHash }),
        }),
      );
      // Un-checking an auto-cleared hunk overrides the pre-check; checking clears the override.
      const o = new Set(uncheckedRef.current);
      for (const id of ids) {
        if (value) o.delete(id);
        else if (autoRef.current.has(id)) o.add(id);
      }
      setAutoUnchecked(o);
      saveSet(overrideKey, o);
    },
    [sync, overrideKey, pr.headSha, diffHash],
  );

  const status = useCallback(
    (id: string) => hunkStatus(id, reviewed, auto, autoUnchecked),
    [reviewed, auto, autoUnchecked],
  );

  const toggleHunk = useCallback(
    (id: string) => {
      const s = hunkStatus(id, sync.current(), autoRef.current, uncheckedRef.current);
      setHunks([id], s === 'none');
    },
    [sync, setHunks],
  );

  const toggleVerify = useCallback(
    (id: string) => {
      const wire = verifyWireArgs(id);
      if (!wire) return;
      const prev = verifyRef.current;
      const checked = !prev.has(id);
      setVerifyChecked((cur) => {
        const next = new Set(cur);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      });
      api('/api/verify', {
        method: 'PUT',
        ...jsonBody({ ...wire, checked }),
      }).catch((err: unknown) => {
        setVerifyChecked((cur) => {
          const next = new Set(cur);
          if (checked) next.delete(id);
          else next.add(id);
          return next;
        });
        setError(`Could not save checklist: ${(err as Error).message}`);
      });
    },
    [setError],
  );

  const markDoneReviewing = useCallback(async () => {
    try {
      await api('/api/review-checkpoint', {
        method: 'POST',
        ...jsonBody({ headSha: pr.headSha, diffHash }),
      });
    } catch (err) {
      setErrorState(describeReviewedError(err));
      return;
    }
    await reloadInterdiff();
  }, [pr.headSha, diffHash, reloadInterdiff]);

  const reReview = useMemo(() => reReviewInfo(interdiff), [interdiff]);
  const hideReviewed = effectiveHideReviewed(hideChoice, reReview);
  const dismissError = useCallback(() => setErrorState(null), []);

  const value = useMemo<ReviewStateValue>(
    () => ({
      reviewed,
      knownItemIds,
      fileKeys,
      analysisStale: stale,
      status,
      toggleHunk,
      setHunks,
      verifyChecked,
      toggleVerify,
      interdiff,
      reReview,
      hideReviewed,
      setHideReviewed: setHideChoice,
      checkHead,
      reloadInterdiff,
      markDoneReviewing,
      error,
      errorNeedsRefresh: errorState?.needsRefresh ?? false,
      dismissError,
    }),
    [
      reviewed,
      knownItemIds,
      fileKeys,
      stale,
      status,
      toggleHunk,
      setHunks,
      verifyChecked,
      toggleVerify,
      interdiff,
      reReview,
      hideReviewed,
      checkHead,
      reloadInterdiff,
      markDoneReviewing,
      error,
      errorState,
      dismissError,
    ],
  );
  const focus = useMemo(() => ({ hunkId: focusedId, setHunkId: setFocusedId }), [focusedId]);

  return (
    <ReviewStateContext.Provider value={value}>
      <FocusContext.Provider value={focus}>{children}</FocusContext.Provider>
    </ReviewStateContext.Provider>
  );
}

/**
 * Sections minus hunks the user marked reviewed, while "Hide reviewed hunks" is on. A hunkless
 * file section is hidden only when its file key is reviewed.
 */
export function useVisibleSections(sections: DiffSection[]): DiffSection[] {
  const { hideReviewed, reviewed, fileKeys } = useReviewState();
  return useMemo(
    () =>
      hideReviewed
        ? filterSections(
            sections,
            (h) => reviewed.has(h.id),
            (path) => {
              const key = fileKeys.get(path);
              return key !== undefined && reviewed.has(key);
            },
          )
        : sections,
    [sections, hideReviewed, reviewed, fileKeys],
  );
}
