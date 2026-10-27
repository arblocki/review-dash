import { fnv1a8 } from '../../core/hash';
import { FILES_WITHOUT_DIFF_TITLE } from '../../core/group/types';
import type { Progress } from './progress';
import type { Analysis, AnalysisGroup, Hunk } from '../types';

/** Which grouping the main pane shows. 'file' is the M1 all-files view. */
export type ViewMode = 'group' | 'tests' | 'file';

export const VIEW_LABELS: Record<ViewMode, string> = {
  group: 'By group',
  tests: 'Tests first',
  file: 'By file',
};

/**
 * The view to show: the user's choice, else By group once an analysis exists. A stale analysis
 * (computed for an older head) is never presented as current, so it forces By file.
 */
export function resolveView(
  choice: ViewMode | null,
  hasAnalysis: boolean,
  stale: boolean,
): ViewMode {
  if (stale) return 'file';
  return choice ?? (hasAnalysis ? 'group' : 'file');
}

/** Groups in the order a view shows them. Analysis order is already risk/dependency order. */
export function orderGroups(groups: AnalysisGroup[], view: ViewMode): AnalysisGroup[] {
  if (view !== 'tests') return groups;
  return [...groups.filter((g) => g.kind === 'test'), ...groups.filter((g) => g.kind !== 'test')];
}

export function groupByKey(groups: AnalysisGroup[]): Map<string, AnalysisGroup> {
  return new Map(groups.map((g) => [g.key, g]));
}

/** Hunk id -> key of the group that holds it (first wins if a hunk is somehow in two). */
export function hunkToGroup(groups: AnalysisGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) for (const id of g.hunkIds) if (!out.has(id)) out.set(id, g.key);
  return out;
}

/** The selected group, falling back to the first one when the key is unset or stale. */
export function pickGroup(groups: AnalysisGroup[], key: string | null): AnalysisGroup | undefined {
  return groups.find((g) => g.key === key) ?? groups[0];
}

export interface GroupNeighbors {
  prev: string | undefined;
  next: string | undefined;
  /** 1-based position in display order, and the group count. */
  position: number;
  total: number;
}

/** Keys of the groups before and after `key` in display order (for prev/next buttons). */
export function groupNeighbors(groups: Pick<AnalysisGroup, 'key'>[], key: string): GroupNeighbors {
  const i = groups.findIndex((g) => g.key === key);
  return {
    prev: i > 0 ? groups[i - 1]!.key : undefined,
    next: i >= 0 && i < groups.length - 1 ? groups[i + 1]!.key : undefined,
    position: i + 1,
    total: groups.length,
  };
}

/** Compact count: "3", "3 · 2f", or "2f" when the group only has hunkless files. */
export function railCount(g: Pick<AnalysisGroup, 'hunkIds' | 'files'>): string {
  const h = g.hunkIds.length;
  const f = g.files.length;
  if (f === 0) return String(h);
  return h === 0 ? `${f}f` : `${h} · ${f}f`;
}

export type BadgeTone = 'high' | 'medium' | 'low' | 'auto' | 'unclassified';

export interface RiskBadgeInfo {
  label: string;
  tone: BadgeTone;
}

export function riskBadge(
  g: Pick<AnalysisGroup, 'risk' | 'autoClear' | 'unclassified'>,
): RiskBadgeInfo {
  if (g.unclassified) return { label: '!!', tone: 'unclassified' };
  if (g.autoClear) return { label: 'AUTO', tone: 'auto' };
  if (g.risk === 'high') return { label: 'HIGH', tone: 'high' };
  if (g.risk === 'medium') return { label: 'MED', tone: 'medium' };
  return { label: 'LOW', tone: 'low' };
}

/**
 * One line for the narrow-screen group selector: risk badge, title and count. With `progress`,
 * a finished group gets a leading check and the rest show done/total in place of the count.
 */
export function groupOptionLabel(
  g: Pick<AnalysisGroup, 'risk' | 'autoClear' | 'unclassified' | 'title' | 'hunkIds' | 'files'>,
  progress?: Pick<Progress, 'done' | 'total' | 'complete'>,
): string {
  if (!progress) return `${riskBadge(g).label} · ${g.title} (${railCount(g)})`;
  const done = progress.complete && progress.total > 0;
  const count = done ? railCount(g) : `${progress.done}/${progress.total}`;
  return `${done ? '✓ ' : ''}${riskBadge(g).label} · ${g.title} (${count})`;
}

/** FNV-1a (32-bit) of a string as 8 hex chars (shared with the server's verify-check keys). */
export const hash8 = fnv1a8;

/**
 * Stable id for one verify checkbox: `${groupKey}:${index}:${hash8(text)}`. The text hash means a
 * checkmark does not carry over to a different item when a re-analysis changes the checklist.
 */
export function verifyId(groupKey: string, index: number, text: string): string {
  return `${groupKey}:${index}:${hash8(text)}`;
}

/** Inverse of `verifyId`. Group keys may contain ':' so index and hash come after the last two. */
export function parseVerifyId(
  id: string,
): { groupKey: string; index: number; hash: string } | null {
  const m = /^(.+):(\d+):([0-9a-f]{8})$/.exec(id);
  return m ? { groupKey: m[1]!, index: Number(m[2]), hash: m[3]! } : null;
}

/**
 * What `PUT /api/verify` stores for a verify id: the text hash rides along in the group key
 * (`${groupKey}#${hash}`) so the backend stays unchanged, and a checkmark saved for one text is
 * never read back for a different text at the same index.
 */
export function verifyWireArgs(id: string): { groupKey: string; itemIndex: number } | null {
  const p = parseVerifyId(id);
  return p ? { groupKey: `${p.groupKey}#${p.hash}`, itemIndex: p.index } : null;
}

/**
 * Verify ids for the `verifyChecks` map of GET /api/review-state. Entries stored without a text
 * hash (before text-keyed ids) cannot be tied to a text, so they are dropped.
 */
export function verifyIdsFromWire(checks: Record<string, number[]>): string[] {
  const out: string[] = [];
  for (const [key, indexes] of Object.entries(checks)) {
    const m = /^(.+)#([0-9a-f]{8})$/.exec(key);
    if (!m) continue;
    for (const i of indexes) out.push(`${m[1]}:${i}:${m[2]}`);
  }
  return out;
}

/** Number of hunks that actually exist in the PR (stale ids are ignored). */
export function countKnownHunks(group: AnalysisGroup, hunks: Iterable<Hunk>): number {
  const known = new Set<string>();
  for (const h of hunks) known.add(h.id);
  return group.hunkIds.filter((id) => known.has(id)).length;
}

/** "3 hunks · 2 files", "2 files", or "0 hunks" for an empty group. */
export function itemCounts(group: Pick<AnalysisGroup, 'hunkIds' | 'files'>): string {
  const h = group.hunkIds.length;
  const f = group.files.length;
  const hunks = `${h} ${h === 1 ? 'hunk' : 'hunks'}`;
  const files = `${f} ${f === 1 ? 'file' : 'files'}`;
  if (f === 0) return hunks;
  return h === 0 ? files : `${hunks} · ${files}`;
}

/** The "GitHub did not return a diff" group (patch missing / binary files). */
export function isFilesWithoutDiff(group: Pick<AnalysisGroup, 'title'>): boolean {
  return group.title === FILES_WITHOUT_DIFF_TITLE;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** Small usage line pieces, e.g. ["12k in / 1.2k out tokens", "$0.04", "8.3s"]. */
export function usageParts(a: Pick<Analysis, 'usage' | 'durationMs'>): string[] {
  const parts: string[] = [];
  const u = a.usage;
  if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
    parts.push(
      `${formatTokens(u.inputTokens ?? 0)} in / ${formatTokens(u.outputTokens ?? 0)} out tokens`,
    );
  }
  if (u?.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(u.costUsd < 0.1 ? 3 : 2)}`);
  parts.push(formatDuration(a.durationMs));
  return parts;
}

export interface ErrorInfo {
  title: string;
  hint: string;
}

/** Friendly message for an /api/analysis error code. */
export function describeAnalysisError(code: string | undefined, message: string): ErrorInfo {
  switch (code) {
    case 'not_installed':
      return {
        title: 'The analysis provider is not installed',
        hint: 'Install and log in to the claude CLI, or switch provider.',
      };
    case 'auth':
      return {
        title: 'The analysis provider is not signed in',
        hint: 'Log in to the provider (or set its API key), or switch provider.',
      };
    case 'unsupported':
      return {
        title: 'The provider CLI is too old to run read-only',
        hint: 'Upgrade the CLI so review-dash can restrict its tools, or switch provider.',
      };
    case 'config':
      return {
        title: 'The analysis provider is misconfigured',
        hint: 'Check ~/.config/review-dash/config.json and your .env, or switch provider.',
      };
    case 'timeout':
      return {
        title: 'The analysis timed out',
        hint: 'Try Re-analyze, or pick a faster model or provider.',
      };
    case 'bad_request':
      return { title: 'Invalid analysis request', hint: message };
    default:
      return { title: 'Analysis failed', hint: 'Try Re-analyze, or switch provider.' };
  }
}
