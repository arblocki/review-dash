import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { GitHubClient } from '../github/types.js';
import type { PrRef } from '../pr-ref.js';
import { BUILTIN_RULES, type RiskRule } from './rules.js';

export const REPO_CONFIG_FILES = ['.review-dash.yaml', '.review-dash.yml'] as const;

const regexString = z.string().refine(
  (s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'invalid regular expression' },
);

const ruleSchema = z
  .object({
    glob: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Regex tested against each added or removed line. */
    pattern: regexString.optional(),
    risk: z.enum(['high', 'medium', 'low']),
    reason: z.string().trim().min(1),
  })
  .refine((r) => r.glob !== undefined || r.pattern !== undefined, {
    message: 'a rule needs a glob or a pattern',
  });

export const repoConfigSchema = z.object({
  rules: z.array(ruleSchema).optional(),
  notes: z.string().optional(),
});

export interface RepoConfig {
  /** Per-repo rules in risk-rule form (not merged with the built-ins). */
  rules: RiskRule[];
  /** Extra guidance for the grouping model, like REVIEW.md. */
  notes?: string;
}

/** Parses the text of a .review-dash.yaml. Throws an Error with a readable message. */
export function parseRepoConfig(text: string): RepoConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message.split('\n')[0]}`, { cause: err });
  }
  const parsed = repoConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  const rules = (parsed.data.rules ?? []).map((r): RiskRule => {
    const rule: RiskRule = { risk: r.risk, reason: r.reason };
    if (r.glob !== undefined) rule.glob = r.glob;
    if (r.pattern !== undefined) rule.pattern = new RegExp(r.pattern);
    return rule;
  });
  const config: RepoConfig = { rules };
  const notes = parsed.data.notes?.trim();
  if (notes) config.notes = notes;
  return config;
}

export interface LoadedRepoConfig {
  /** Built-ins plus the repo's rules: pass as analyzePr's `rules`. */
  rules: readonly RiskRule[];
  notes?: string;
  /** Set when a rules file exists but could not be used; analysis falls back to built-ins. */
  warning?: string;
  /** Hash of the rules file text ('' when none); part of the analysis cache key. */
  hash: string;
}

function isNotFound(err: unknown): boolean {
  return (err as { status?: unknown }).status === 404;
}

/** Fetches and parses the reviewed repo's rules file at `sha`. A missing file is not an error. */
export async function loadRepoConfig(
  github: Pick<GitHubClient, 'fetchFileContent'>,
  ref: PrRef,
  sha: string,
): Promise<LoadedRepoConfig> {
  for (const file of REPO_CONFIG_FILES) {
    let text: string;
    try {
      text = await github.fetchFileContent(ref, file, sha);
    } catch (err) {
      if (isNotFound(err)) continue;
      return {
        rules: BUILTIN_RULES,
        hash: '',
        warning: `Could not read ${file}: ${(err as Error).message}`,
      };
    }
    const hash = createHash('sha1').update(`${file}\n${text}`).digest('hex');
    try {
      const config = parseRepoConfig(text);
      return {
        rules: [...BUILTIN_RULES, ...config.rules],
        ...(config.notes ? { notes: config.notes } : {}),
        hash,
      };
    } catch (err) {
      return {
        rules: BUILTIN_RULES,
        hash,
        warning: `Ignoring ${file}: ${(err as Error).message}`,
      };
    }
  }
  return { rules: BUILTIN_RULES, hash: '' };
}
