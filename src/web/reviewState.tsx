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
import { parseVerifyId, verifyId } from './lib/groups';
import { filterSections } from './lib/reviewFilter';
import { allItemIds, fileKeyMap } from './lib/reviewItems';
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
  /** Re-fetches interdiff; `reset` also drops the sticky banner (after submitting a review). */
  reloadInterdiff(reset?: boolean): Promise<void>;
  error: string | null;
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
  const { session, files, pr } = useReview();
  const { result } = useAnalysis();
  const [reviewed, setReviewedState] = useState<ReadonlySet<string>>(new Set());
  const [verifyChecked, setVerifyChecked] = useState<ReadonlySet<string>>(new Set());
  const [interdiff, setInterdiff] = useState<InterdiffResponse | null>(null);
  // Marking a hunk reviewed moves the server's "last reviewed head" to the current head, which
  // would end the re-review mid-session. The banner (and its default) stays until reload.
  const [latched, setLatched] = useState<InterdiffResponse | null>(null);
  const [hideChoice, setHideChoice] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Auto-clear is never stored, so un-checking an auto-cleared hunk is a local override.
  const overrideKey = `review-dash:autoUnchecked:${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
  const [autoUnchecked, setAutoUnchecked] = useState<ReadonlySet<string>>(() =>
    loadSet(overrideKey),
  );

  const reviewedRef = useRef(reviewed);
  reviewedRef.current = reviewed;
  const verifyRef = useRef(verifyChecked);
  verifyRef.current = verifyChecked;
  const uncheckedRef = useRef(autoUnchecked);
  uncheckedRef.current = autoUnchecked;

  const fileKeys = useMemo(() => fileKeyMap(files, pr.headSha), [files, pr.headSha]);
  const knownItemIds = useMemo(() => allItemIds(files, pr.headSha), [files, pr.headSha]);
  const auto = useMemo(
    () => (result ? autoClearIds(result.analysis.groups, fileKeys) : new Set<string>()),
    [result, fileKeys],
  );
  const autoRef = useRef(auto);
  autoRef.current = auto;

  useEffect(() => {
    api<ReviewStateResponse>('/api/review-state').then(
      (s) => {
        // Local edits made before this arrived win.
        setReviewedState((cur) => new Set([...s.reviewedHunkIds, ...cur]));
        setVerifyChecked(
          (cur) =>
            new Set([
              ...Object.entries(s.verifyChecks).flatMap(([k, idx]) =>
                idx.map((i) => verifyId(k, i, '')),
              ),
              ...cur,
            ]),
        );
      },
      (err: unknown) => setError(`Could not load reviewed state: ${(err as Error).message}`),
    );
  }, []);

  const reloadInterdiff = useCallback(async (reset?: boolean) => {
    if (reset) setLatched(null);
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
      const prev = reviewedRef.current;
      const next = new Set(prev);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      setReviewedState(next);
      // Un-checking an auto-cleared hunk overrides the pre-check; checking clears the override.
      const o = new Set(uncheckedRef.current);
      for (const id of ids) {
        if (value) o.delete(id);
        else if (autoRef.current.has(id)) o.add(id);
      }
      setAutoUnchecked(o);
      saveSet(overrideKey, o);
      api('/api/reviewed', { method: 'PUT', ...jsonBody({ hunkIds: ids, reviewed: value }) }).catch(
        (err: unknown) => {
          // Roll back just these ids.
          setReviewedState((cur) => {
            const rolled = new Set(cur);
            for (const id of ids) {
              if (prev.has(id)) rolled.add(id);
              else rolled.delete(id);
            }
            return rolled;
          });
          setError(`Could not save reviewed state: ${(err as Error).message}`);
        },
      );
    },
    [overrideKey],
  );

  const status = useCallback(
    (id: string) => hunkStatus(id, reviewed, auto, autoUnchecked),
    [reviewed, auto, autoUnchecked],
  );

  const toggleHunk = useCallback(
    (id: string) => {
      const s = hunkStatus(id, reviewedRef.current, autoRef.current, uncheckedRef.current);
      setHunks([id], s === 'none');
    },
    [setHunks],
  );

  const toggleVerify = useCallback((id: string) => {
    const parsed = parseVerifyId(id);
    if (!parsed) return;
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
      ...jsonBody({ groupKey: parsed.groupKey, itemIndex: parsed.index, checked }),
    }).catch((err: unknown) => {
      setVerifyChecked((cur) => {
        const next = new Set(cur);
        if (checked) next.delete(id);
        else next.add(id);
        return next;
      });
      setError(`Could not save checklist: ${(err as Error).message}`);
    });
  }, []);

  useEffect(() => {
    if (interdiff && reReviewInfo(interdiff)) setLatched(interdiff);
  }, [interdiff]);
  const banner = latched ?? interdiff;
  const reReview = useMemo(() => reReviewInfo(banner), [banner]);
  const hideReviewed = effectiveHideReviewed(hideChoice, reReview);
  const dismissError = useCallback(() => setError(null), []);

  const value = useMemo<ReviewStateValue>(
    () => ({
      reviewed,
      knownItemIds,
      fileKeys,
      status,
      toggleHunk,
      setHunks,
      verifyChecked,
      toggleVerify,
      interdiff: banner,
      reReview,
      hideReviewed,
      setHideReviewed: setHideChoice,
      checkHead,
      reloadInterdiff,
      error,
      dismissError,
    }),
    [
      reviewed,
      knownItemIds,
      fileKeys,
      status,
      toggleHunk,
      setHunks,
      verifyChecked,
      toggleVerify,
      banner,
      reReview,
      hideReviewed,
      checkHead,
      reloadInterdiff,
      error,
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
