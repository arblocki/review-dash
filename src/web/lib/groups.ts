import { FILES_WITHOUT_DIFF_TITLE } from '../../core/group/types';
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

/** Stable id for one verify checkbox; the reviewed-state layer can persist on this. */
export function verifyId(groupKey: string, index: number): string {
  return `${groupKey}:${index}`;
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
