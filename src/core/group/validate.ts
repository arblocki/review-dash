import type { ClassifiedHunk } from '../classify/index.js';
import {
  assessLockfileHunks,
  LOCKFILE_INTEGRITY_REASON,
  LOCKFILE_NO_MANIFEST_REASON,
} from '../classify/lockfile.js';
import { BUILTIN_RULES, firedRules, ruleMatchesHunk, type RiskRule } from '../risk/rules.js';
import { maxRisk, type Risk } from '../risk/types.js';
import { classifyFile } from '../classify/index.js';
import type { ParsedFile } from '../diff/types.js';
import { ruleMatchesTarget } from '../risk/rules.js';
import type { GroupingOutput } from './prompt.js';
import {
  LOCKFILE_TITLE,
  FILES_WITHOUT_DIFF_TITLE,
  MECHANICAL_FLAGGED_TITLE,
  MECHANICAL_TITLE,
  UNCLASSIFIED_TITLE,
  type DraftGroup,
} from './types.js';

export interface ValidateOptions {
  /** Rules used to vet mechanical hunks (defaults to the built-ins). */
  rules?: readonly RiskRule[];
  /** All changed files; those without hunks are placed in `files` of exactly one group. */
  files?: readonly ParsedFile[];
}

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
  opts: ValidateOptions = {},
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
    return finishValidation(
      groups,
      hunks,
      allPaths,
      opts,
      missing.length,
      unknownIds,
      duplicateIds,
    );
  }
  return finishValidation(
    [...fallbackGrouping(reviewable)],
    hunks,
    allPaths,
    opts,
    0,
    unknownIds,
    duplicateIds,
  );
}

function finishValidation(
  groups: DraftGroup[],
  hunks: readonly ClassifiedHunk[],
  allPaths: readonly string[],
  opts: ValidateOptions,
  backfilled: number,
  unknownIds: number,
  duplicateIds: number,
): ValidateResult {
  const { flagged } = assessLockfileHunks(hunks, allPaths);
  const lock = lockfileGroup(hunks, flagged);
  if (lock) groups.push(lock);
  const rules = opts.rules ?? BUILTIN_RULES;
  const clean: ClassifiedHunk[] = [];
  const risky: { hunk: ClassifiedHunk; risk: Risk; reasons: string[] }[] = [];
  for (const c of hunks) {
    if (!c.mechanical || flagged.has(c.hunk.id)) continue;
    const f = firedRules(rules, (r) => ruleMatchesHunk(r, c));
    if (f.risk === 'low') clean.push(c);
    else risky.push({ hunk: c, ...f });
  }
  const cleanFiles: string[] = [];
  const riskyFiles: { path: string; risk: Risk; reasons: string[] }[] = [];
  const noDiff: ParsedFile[] = [];
  for (const f of opts.files ?? []) {
    if (f.hunks.length > 0) continue;
    const pureRename =
      (f.status === 'renamed' || f.status === 'copied') &&
      !f.patchMissing &&
      !f.binary &&
      f.additions === 0 &&
      f.deletions === 0;
    if (!pureRename) {
      noDiff.push(f);
      continue;
    }
    const tags = classifyFile(f);
    const paths = f.oldPath ? [f.path, f.oldPath] : [f.path];
    const fired = firedRules(rules, (r) =>
      paths.some((path) => ruleMatchesTarget(r, { path, tags, changed: [] })),
    );
    if (fired.risk === 'low') cleanFiles.push(f.path);
    else riskyFiles.push({ path: f.path, ...fired });
  }
  const mech = mechanicalGroup(clean, cleanFiles);
  if (mech) groups.push(mech);
  const flaggedMech = flaggedMechanicalGroup(risky, riskyFiles);
  if (flaggedMech) groups.push(flaggedMech);
  const noDiffGroup = filesWithoutDiffGroup(noDiff);
  if (noDiffGroup) groups.push(noDiffGroup);
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

export function mechanicalGroup(
  hunks: readonly ClassifiedHunk[],
  files: readonly string[] = [],
): DraftGroup | undefined {
  const ids = hunks.filter((c) => c.mechanical).map((c) => c.hunk.id);
  if (ids.length === 0 && files.length === 0) return undefined;
  return {
    title: MECHANICAL_TITLE,
    intent: 'Generated code, snapshots, vendored code, renames.',
    kind: 'mechanical',
    risk: 'low',
    riskReasons: [],
    verify: [],
    hunkIds: ids,
    files: [...files],
    dependsOnIdx: [],
    llmIndex: -1,
    mechanical: true,
    autoClear: true,
  };
}

/** Mechanical hunks that trip a medium/high risk rule: never auto-cleared, never `mechanical: true`. */
function flaggedMechanicalGroup(
  risky: readonly { hunk: ClassifiedHunk; risk: Risk; reasons: string[] }[],
  riskyFiles: readonly { path: string; risk: Risk; reasons: string[] }[] = [],
): DraftGroup | undefined {
  if (risky.length === 0 && riskyFiles.length === 0) return undefined;
  let risk: Risk = 'medium';
  const riskReasons: string[] = [];
  for (const r of [...risky, ...riskyFiles]) {
    risk = maxRisk(risk, r.risk);
    for (const reason of r.reasons) if (!riskReasons.includes(reason)) riskReasons.push(reason);
  }
  return {
    title: MECHANICAL_FLAGGED_TITLE,
    intent:
      'Generated, vendored or renamed changes in files that risk rules cover. Look at these before trusting the label.',
    kind: 'mechanical',
    risk,
    riskReasons,
    verify: [],
    hunkIds: risky.map((r) => r.hunk.hunk.id),
    files: riskyFiles.map((r) => r.path),
    dependsOnIdx: [],
    llmIndex: -1,
    autoClear: false,
  };
}

/** Hunkless files that are not pure renames: no diff from GitHub, binary, mode-only changes, empty files. */
function filesWithoutDiffGroup(files: readonly ParsedFile[]): DraftGroup | undefined {
  if (files.length === 0) return undefined;
  const missing = files.filter((f) => f.patchMissing).length;
  const binary = files.filter((f) => !f.patchMissing && f.binary).length;
  const other = files.length - missing - binary;
  const riskReasons: string[] = [];
  if (missing > 0) riskReasons.push(`GitHub did not return a diff for ${missing} file(s)`);
  if (binary > 0) riskReasons.push('Binary file(s) changed');
  if (other > 0) riskReasons.push(`${other} file(s) changed without a textual diff`);
  return {
    title: FILES_WITHOUT_DIFF_TITLE,
    intent:
      'Files with no reviewable hunks here: too large for GitHub to diff, binary, or changed without text edits. Open them on GitHub.',
    kind: 'other',
    risk: 'medium',
    riskReasons,
    verify: [],
    hunkIds: [],
    files: files.map((f) => f.path),
    dependsOnIdx: [],
    llmIndex: -1,
    autoClear: false,
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
