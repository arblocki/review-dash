import { classifyFiles, type ClassifiedHunk } from '../classify/index.js';
import type { ParsedFile } from '../diff/types.js';
import { completeJson } from '../llm/json.js';
import { LlmError, type LlmProvider, type LlmUsage } from '../llm/types.js';
import { applyRisk } from '../risk/apply.js';
import { BUILTIN_RULES, type RiskRule } from '../risk/rules.js';
import { orderGroups } from './order.js';
import { preGroup, type Cluster } from './pregroup.js';
import {
  buildClusterSummaryPrompt,
  buildGroupingPrompt,
  buildReducePrompt,
  CLUSTER_SUMMARY_JSON_SCHEMA,
  clusterSummarySchema,
  estimateTokens,
  GROUPING_JSON_SCHEMA,
  groupingOutputSchema,
  PROMPT_VERSION,
  type ClusterSummary,
  type GroupingOutput,
} from './prompt.js';
import type { Analysis, AnalysisGroup } from './types.js';
import { validateGrouping } from './validate.js';

export const DEFAULT_TOKEN_BUDGET = 120_000;

export interface AnalyzeConfig {
  /** Max parallel map calls. */
  maxConcurrency?: number;
  /** Estimated prompt tokens (chars / 4) above which map-reduce kicks in. */
  tokenBudget?: number;
  /** Per-hunk line cap in prompts. */
  maxHunkLines?: number;
}

export interface AnalyzeInput {
  pr: { title: string; body: string };
  files: readonly ParsedFile[];
  provider: LlmProvider;
  model: string;
  config?: AnalyzeConfig;
  /** Provider for the map step (e.g. a cheaper model). Defaults to `provider`. */
  mapProvider?: LlmProvider;
  reviewMd?: string;
  /** Rules used instead of the built-ins (the built-ins plus per-repo rules). */
  rules?: readonly RiskRule[];
  signal?: AbortSignal;
}

function addUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    costUsd: sum(a.costUsd, b.costUsd),
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface LlmStep {
  output: GroupingOutput;
  usage?: LlmUsage;
  mapReduce: boolean;
}

async function runMapReduce(
  input: AnalyzeInput,
  reviewable: readonly ClassifiedHunk[],
  clusters: readonly Cluster[],
): Promise<LlmStep> {
  const mapProvider = input.mapProvider ?? input.provider;
  const concurrency = input.config?.maxConcurrency ?? 4;
  let usage: LlmUsage | undefined;
  const summaries = new Map<string, ClusterSummary>();

  await mapPool(clusters, concurrency, async (cluster) => {
    const p = buildClusterSummaryPrompt({ pr: input.pr, cluster, hunks: reviewable });
    try {
      const r = await completeJson(
        mapProvider,
        { ...p, jsonSchema: CLUSTER_SUMMARY_JSON_SCHEMA, signal: input.signal },
        clusterSummarySchema,
      );
      usage = addUsage(usage, r.usage);
      summaries.set(cluster.id, r.value);
    } catch (err) {
      // An unusable summary only degrades the reduce input; other errors propagate.
      if (!(err instanceof LlmError) || err.kind !== 'bad_output') throw err;
    }
  });

  const reduce = buildReducePrompt({
    pr: input.pr,
    clusters,
    summaries,
    hunks: reviewable,
    reviewMd: input.reviewMd,
  });
  const r = await completeJson(
    input.provider,
    { ...reduce, jsonSchema: GROUPING_JSON_SCHEMA, signal: input.signal },
    groupingOutputSchema,
  );
  return { output: r.value, usage: addUsage(usage, r.usage), mapReduce: true };
}

async function runGrouping(
  input: AnalyzeInput,
  reviewable: readonly ClassifiedHunk[],
  clusters: readonly Cluster[],
): Promise<LlmStep> {
  const prompt = buildGroupingPrompt({
    pr: input.pr,
    hunks: reviewable,
    clusters,
    reviewMd: input.reviewMd,
    maxHunkLines: input.config?.maxHunkLines,
  });
  const budget = input.config?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  if (estimateTokens(prompt) > budget) return runMapReduce(input, reviewable, clusters);
  const r = await completeJson(
    input.provider,
    { ...prompt, jsonSchema: GROUPING_JSON_SCHEMA, signal: input.signal },
    groupingOutputSchema,
  );
  return { output: r.value, usage: r.usage, mapReduce: false };
}

/**
 * classify -> pre-group -> LLM refine -> validate -> risk -> order.
 * Provider errors other than bad output (not installed, auth, timeout, ...) are thrown;
 * bad output after the retry falls back to a deterministic directory grouping.
 */
export async function analyzePr(input: AnalyzeInput): Promise<Analysis> {
  const started = Date.now();
  const classified = classifyFiles(input.files);
  const reviewable = classified.filter((c) => !c.mechanical);
  const hunkById = new Map(classified.map((c) => [c.hunk.id, c]));

  let step: LlmStep | undefined;
  let fallback = false;
  if (reviewable.length > 0) {
    try {
      step = await runGrouping(input, reviewable, preGroup(classified));
    } catch (err) {
      if (!(err instanceof LlmError) || err.kind !== 'bad_output') throw err;
      fallback = true;
    }
  }

  const rules = input.rules ?? BUILTIN_RULES;
  const validated = validateGrouping(
    step?.output,
    classified,
    input.files.map((f) => f.path),
    { rules },
  );
  const finalized = validated.groups.map((g) => applyRisk(g, hunkById, rules));
  const groups: AnalysisGroup[] = orderGroups(finalized, hunkById).map((g) => {
    const out: AnalysisGroup = {
      key: g.key,
      title: g.title,
      intent: g.intent,
      kind: g.kind,
      risk: g.risk,
      riskReasons: g.riskReasons,
      verify: g.verify,
      hunkIds: g.hunkIds,
      dependsOn: g.dependsOn,
      autoClear: g.autoClear ?? false,
    };
    if (g.unclassified) out.unclassified = true;
    return out;
  });

  let summary: string;
  if (step) summary = step.output.summary;
  else if (fallback) {
    summary = `${reviewable.length} hunks in ${new Set(reviewable.map((c) => c.hunk.path)).size} files, grouped by directory because the model's output was unusable.`;
  } else if (classified.length > 0) {
    summary = `Only mechanical changes (${classified.length} hunks).`;
  } else summary = 'No reviewable hunks in this pull request.';

  const analysis: Analysis = {
    summary,
    groups,
    unrelatedOrSuspicious: step?.output.unrelated_or_suspicious ?? [],
    fallback,
    backfilled: validated.backfilled,
    mapReduce: step?.mapReduce ?? false,
    provider: input.provider.id,
    model: input.model,
    promptVersion: PROMPT_VERSION,
    durationMs: Date.now() - started,
  };
  if (step?.usage) analysis.usage = step.usage;
  return analysis;
}
