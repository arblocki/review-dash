import type { ClassifiedHunk, Tag } from '../classify/index.js';
import { matchGlob } from './glob.js';
import { maxRisk, type Risk } from './types.js';

/**
 * A risk rule. A hunk matches when every given condition holds:
 * - `glob` / `pathPattern` match its file path,
 * - `pattern` matches the content of at least one added or removed line,
 * - none of `excludeTags` is among the hunk's tags.
 * A rule needs at least one of glob / pathPattern / pattern. A group fires the rule if
 * any of its hunks matches. Per-repo rules from .review-dash.yaml map onto this directly.
 */
export interface RiskRule {
  risk: Risk;
  reason: string;
  glob?: string | readonly string[];
  pathPattern?: RegExp;
  pattern?: RegExp;
  excludeTags?: readonly Tag[];
}

const NOT_CODE: readonly Tag[] = ['test', 'docs'];

export const BUILTIN_RULES: readonly RiskRule[] = [
  {
    risk: 'high',
    reason: 'Touches authentication, session, crypto or secrets code',
    pathPattern:
      /(^|\/)[^/]*(auth|session|crypto|password|passwd|token|secret|oauth|jwt|credential|permission)[^/]*(\/|$)/i,
    excludeTags: NOT_CODE,
  },
  {
    risk: 'high',
    reason: 'Changes a CI workflow',
    glob: '.github/workflows/**',
  },
  {
    risk: 'high',
    reason: 'Database migration',
    pathPattern: /(^|\/)(migrations?|migrate|alembic\/versions)\//i,
    excludeTags: ['docs'],
  },
  {
    risk: 'medium',
    reason: 'Changes dependency manifest',
    glob: [
      'package.json',
      'pyproject.toml',
      'Pipfile',
      'requirements*.txt',
      'Cargo.toml',
      'go.mod',
      'Gemfile',
      'composer.json',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
    ],
  },
  {
    risk: 'medium',
    reason: 'Changes infrastructure or deployment config',
    glob: [
      'Dockerfile*',
      '*.dockerfile',
      '*.tf',
      'docker-compose*.y*ml',
      'k8s/**',
      'kubernetes/**',
      'helm/**',
      'charts/**',
    ],
  },
  {
    risk: 'medium',
    reason: 'Changes exported (public API) declarations',
    pattern: /^\s*export\s/,
    excludeTags: [...NOT_CODE, 'config', 'generated', 'snapshot'],
  },
];

/** Groups deleting more than this many lines get a medium-risk bump. */
export const LARGE_DELETION_LINES = 100;

export interface RiskAssessment {
  /** Highest risk any rule asked for; 'low' when nothing fired. */
  risk: Risk;
  /** Reasons of the rules that fired (deduplicated, in rule order). */
  reasons: string[];
}

function changedContents(h: ClassifiedHunk): string[] {
  return h.hunk.lines.filter((l) => l.type !== 'context').map((l) => l.content);
}

/** Rule match against a path, its tags and the changed line contents (none for hunkless files). */
export function ruleMatchesTarget(
  rule: RiskRule,
  target: { path: string; tags: readonly Tag[]; changed: readonly string[] },
): boolean {
  if (!rule.glob && !rule.pathPattern && !rule.pattern) return false;
  if (rule.excludeTags?.some((t) => target.tags.includes(t))) return false;
  if (rule.glob && !matchGlob(rule.glob, target.path)) return false;
  if (rule.pathPattern && !rule.pathPattern.test(target.path)) return false;
  if (rule.pattern) {
    const re = rule.pattern;
    if (!target.changed.some((c) => re.test(c))) return false;
  }
  return true;
}

export function ruleMatchesHunk(rule: RiskRule, h: ClassifiedHunk): boolean {
  return ruleMatchesTarget(rule, {
    path: h.hunk.path,
    tags: h.tags,
    changed: changedContents(h),
  });
}

/** Rules (without the large-deletion check) that fire on a single target, medium or higher. */
export function firedRules(
  rules: readonly RiskRule[],
  matches: (rule: RiskRule) => boolean,
): { risk: Risk; reasons: string[] } {
  let risk: Risk = 'low';
  const reasons: string[] = [];
  for (const rule of rules) {
    if (rule.risk === 'low' || !matches(rule)) continue;
    risk = maxRisk(risk, rule.risk);
    if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
  }
  return { risk, reasons };
}

/** Applies rules (built-ins by default) plus the large-deletion check to one group's hunks. */
export function assessRisk(
  hunks: readonly ClassifiedHunk[],
  rules: readonly RiskRule[] = BUILTIN_RULES,
): RiskAssessment {
  let risk: Risk = 'low';
  const reasons: string[] = [];
  const fire = (r: Risk, reason: string) => {
    risk = maxRisk(risk, r);
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  for (const rule of rules) {
    if (hunks.some((h) => ruleMatchesHunk(rule, h))) fire(rule.risk, rule.reason);
  }
  const deleted = hunks.reduce(
    (n, h) => n + h.hunk.lines.filter((l) => l.type === 'del').length,
    0,
  );
  if (deleted > LARGE_DELETION_LINES) fire('medium', `Deletes ${deleted} lines`);
  return { risk, reasons };
}
