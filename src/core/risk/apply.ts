import { isAutoClearable, type ClassifiedHunk } from '../classify/index.js';
import type { DraftGroup } from '../group/types.js';
import { assessRisk, BUILTIN_RULES, type RiskRule } from './rules.js';
import { maxRisk } from './types.js';

/**
 * Final risk = max(model, rules); rule reasons are appended to the model's reasons.
 * Sets `autoClear` (strict): every hunk is mechanical, docs, comment-only or
 * whitespace-only, and the final risk is still low. Only the clean mechanical group (`mechanical: true`,
 * already vetted hunk by hunk against the rules in validate) is passed through.
 */
export function applyRisk(
  group: DraftGroup,
  hunkById: ReadonlyMap<string, ClassifiedHunk>,
  rules: readonly RiskRule[] = BUILTIN_RULES,
): DraftGroup {
  if (group.mechanical) return { ...group, risk: 'low', autoClear: true };
  const hunks = group.hunkIds.flatMap((id) => hunkById.get(id) ?? []);
  const a = assessRisk(hunks, rules);
  let risk = maxRisk(group.risk, a.risk);
  if (group.unclassified) risk = maxRisk(risk, 'medium');
  const riskReasons = [...group.riskReasons];
  for (const r of a.reasons) if (!riskReasons.includes(r)) riskReasons.push(r);
  const autoClear =
    !group.unclassified &&
    risk === 'low' &&
    hunks.length > 0 &&
    hunks.every((h) => isAutoClearable(h.tags));
  return { ...group, risk, riskReasons, autoClear };
}
