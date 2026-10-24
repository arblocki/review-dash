import type { AnalysisGroup } from '../types';

/**
 * 'reviewed' = the user marked it; 'auto' = in an auto-cleared group and not unchecked (never
 * stored as reviewed, PLAN section 12); 'none' = still to do.
 */
export type HunkStatus = 'reviewed' | 'auto' | 'none';

export interface Progress {
  total: number;
  /** Marked by the user. */
  reviewed: number;
  /** Pre-checked by auto-clear and not marked by the user. */
  auto: number;
  /** reviewed + auto. */
  done: number;
  /** 0-100, rounded down so 100 only means everything is done. */
  pct: number;
  complete: boolean;
}

export function progressFor(ids: Iterable<string>, status: (id: string) => HunkStatus): Progress {
  let total = 0;
  let reviewed = 0;
  let auto = 0;
  for (const id of new Set(ids)) {
    total++;
    const s = status(id);
    if (s === 'reviewed') reviewed++;
    else if (s === 'auto') auto++;
  }
  const done = reviewed + auto;
  return {
    total,
    reviewed,
    auto,
    done,
    pct: total === 0 ? 100 : Math.floor((done / total) * 100),
    complete: done === total,
  };
}

/** Status of one hunk given the manual reviewed set, auto-clear membership and user overrides. */
export function hunkStatus(
  id: string,
  reviewed: ReadonlySet<string>,
  autoClear: ReadonlySet<string>,
  autoUnchecked: ReadonlySet<string>,
): HunkStatus {
  if (reviewed.has(id)) return 'reviewed';
  if (autoClear.has(id) && !autoUnchecked.has(id)) return 'auto';
  return 'none';
}

/** Ids of every hunk in an auto-clear group (unclassified groups are never auto-cleared). */
export function autoClearIds(groups: AnalysisGroup[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups)
    if (g.autoClear && !g.unclassified) g.hunkIds.forEach((id) => out.add(id));
  return out;
}

/** Progress per group, counting only hunks that exist in the PR (`known`). */
export function groupProgress(
  groups: AnalysisGroup[],
  known: ReadonlySet<string>,
  status: (id: string) => HunkStatus,
): Map<string, Progress> {
  return new Map(
    groups.map((g) => [
      g.key,
      progressFor(
        g.hunkIds.filter((id) => known.has(id)),
        status,
      ),
    ]),
  );
}
