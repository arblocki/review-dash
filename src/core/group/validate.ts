import type { ClassifiedHunk } from '../classify/index.js';
import {
  assessLockfileHunks,
  LOCKFILE_INTEGRITY_REASON,
  LOCKFILE_NO_MANIFEST_REASON,
} from '../classify/lockfile.js';
import type { GroupingOutput } from './prompt.js';
import { LOCKFILE_TITLE, MECHANICAL_TITLE, UNCLASSIFIED_TITLE, type DraftGroup } from './types.js';

export interface ValidateResult {
  groups: DraftGroup[];
  /** Hunks the model never placed (put into "Unclassified — must read"). */
  backfilled: number;
  unknownIds: number;
  duplicateIds: number;
}

/**
 * Enforces the completeness invariant (4.5): every hunk id lands in exactly one group.
 * - Unknown ids are dropped; duplicates stay in the first group that lists them.
 * - Mechanical hunks always go to "Mechanical changes", whatever the model said.
 * - Missing hunks are back-filled into "Unclassified — must read" (medium risk or higher).
 * - Lockfile hunks without a matching manifest change, or with an integrity/source change but no
 *   version change, go to "Lockfile changes — verify" instead (never auto-cleared).
 * Groups left empty are dropped. `allPaths` lists every changed path in the PR. Pass `output = undefined` for the directory fallback.
 */
export function validateGrouping(
  output: GroupingOutput | undefined,
  hunks: readonly ClassifiedHunk[],
  allPaths: readonly string[] = hunks.map((c) => c.hunk.path),
): ValidateResult {
  const known = new Map(hunks.map((c) => [c.hunk.id, c]));
  const placed = new Set<string>();
  let unknownIds = 0;
  let duplicateIds = 0;
  const groups: DraftGroup[] = [];

  if (output) {
    output.groups.forEach((g, llmIndex) => {
      const ids: string[] = [];
      for (const raw of g.hunk_ids) {
        const id = raw.trim();
        const c = known.get(id);
        if (!c) unknownIds++;
        else if (placed.has(id)) duplicateIds++;
        else if (!c.mechanical) {
          placed.add(id);
          ids.push(id);
        }
        // Mechanical ids the model echoed are ignored here; they are added below.
      }
      if (ids.length === 0) return;
      groups.push({
        title: g.title,
        intent: g.intent,
        kind: g.kind,
        risk: g.risk,
        riskReasons: [...g.risk_reasons],
        verify: [...g.verify],
        hunkIds: ids,
        dependsOnIdx: g.depends_on,
        llmIndex,
      });
    });
  }

  const reviewable = hunks.filter((c) => !c.mechanical);
  if (output) {
    const missing = reviewable.filter((c) => !placed.has(c.hunk.id)).map((c) => c.hunk.id);
    if (missing.length > 0) {
      groups.push({
        title: UNCLASSIFIED_TITLE,
        intent: 'Hunks the grouping step did not assign to any group. Read these directly.',
        kind: 'other',
        risk: 'medium',
        riskReasons: ['Not assigned to a group automatically; needs a manual read'],
        verify: [],
        hunkIds: missing,
        dependsOnIdx: [],
        llmIndex: -1,
        unclassified: true,
      });
    }
    return finishValidation(groups, hunks, allPaths, missing.length, unknownIds, duplicateIds);
  }
  return finishValidation(
    [...fallbackGrouping(reviewable)],
    hunks,
    allPaths,
    0,
    unknownIds,
    duplicateIds,
  );
}

function finishValidation(
  groups: DraftGroup[],
  hunks: readonly ClassifiedHunk[],
  allPaths: readonly string[],
  backfilled: number,
  unknownIds: number,
  duplicateIds: number,
): ValidateResult {
  const { flagged } = assessLockfileHunks(hunks, allPaths);
  const lock = lockfileGroup(hunks, flagged);
  if (lock) groups.push(lock);
  const mech = mechanicalGroup(hunks.filter((c) => !flagged.has(c.hunk.id)));
  if (mech) groups.push(mech);
  return { groups, backfilled, unknownIds, duplicateIds };
}

function lockfileGroup(
  hunks: readonly ClassifiedHunk[],
  flagged: ReturnType<typeof assessLockfileHunks>['flagged'],
): DraftGroup | undefined {
  const ids = hunks.filter((c) => flagged.has(c.hunk.id)).map((c) => c.hunk.id);
  if (ids.length === 0) return undefined;
  const entries = ids.map((id) => flagged.get(id)!);
  const riskReasons: string[] = [];
  for (const m of new Set(entries.flatMap((e) => (e.noManifest ? [e.noManifest] : [])))) {
    riskReasons.push(`${LOCKFILE_NO_MANIFEST_REASON} (${m})`);
  }
  const integrity = entries.some((e) => e.integrity);
  if (integrity) riskReasons.push(LOCKFILE_INTEGRITY_REASON);
  return {
    title: LOCKFILE_TITLE,
    intent:
      'Lockfile edits that are not fully explained by a manifest change. Check that the resolved versions, sources and hashes are what you expect.',
    kind: 'config',
    risk: integrity ? 'high' : 'medium',
    riskReasons,
    verify: [],
    hunkIds: ids,
    dependsOnIdx: [],
    llmIndex: -1,
    autoClear: false,
  };
}

export function mechanicalGroup(hunks: readonly ClassifiedHunk[]): DraftGroup | undefined {
  const ids = hunks.filter((c) => c.mechanical).map((c) => c.hunk.id);
  if (ids.length === 0) return undefined;
  return {
    title: MECHANICAL_TITLE,
    intent: 'Generated code, snapshots, vendored code, renames and whitespace-only edits.',
    kind: 'mechanical',
    risk: 'low',
    riskReasons: [],
    verify: [],
    hunkIds: ids,
    dependsOnIdx: [],
    llmIndex: -1,
    mechanical: true,
    autoClear: true,
  };
}

/** Deterministic grouping by top-level directory, used when the model output is unusable. */
export function fallbackGrouping(reviewable: readonly ClassifiedHunk[]): DraftGroup[] {
  const byDir = new Map<string, string[]>();
  for (const { hunk } of reviewable) {
    const i = hunk.path.indexOf('/');
    const dir = i < 0 ? '(repo root)' : `${hunk.path.slice(0, i)}/`;
    byDir.set(dir, [...(byDir.get(dir) ?? []), hunk.id]);
  }
  return [...byDir].map(([dir, hunkIds]) => ({
    title: `Changes in ${dir}`,
    intent: 'Grouped by top-level directory because automatic grouping was unavailable.',
    kind: 'other' as const,
    risk: 'medium' as const,
    riskReasons: ['Fallback grouping: not analyzed by a model'],
    verify: [],
    hunkIds,
    dependsOnIdx: [],
    llmIndex: -1,
  }));
}
