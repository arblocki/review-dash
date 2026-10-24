import type { LlmUsage } from '../llm/types.js';
import type { Risk } from '../risk/types.js';

export const GROUP_KINDS = [
  'feature',
  'fix',
  'refactor',
  'test',
  'config',
  'docs',
  'mechanical',
  'other',
] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const UNCLASSIFIED_TITLE = 'Unclassified — must read';
export const MECHANICAL_TITLE = 'Mechanical changes';

/** A group on its way through validate -> risk -> order. */
export interface DraftGroup {
  title: string;
  intent: string;
  kind: GroupKind;
  risk: Risk;
  riskReasons: string[];
  verify: string[];
  hunkIds: string[];
  /** Indices into the LLM's `groups` array (not remapped yet). */
  dependsOnIdx: number[];
  /** Position in the LLM's `groups` array; -1 for synthetic groups. */
  llmIndex: number;
  unclassified?: boolean;
  mechanical?: boolean;
  autoClear?: boolean;
}

export interface AnalysisGroup {
  /** Stable across re-analysis of the same hunk set: later layers key verify checks on it. */
  key: string;
  title: string;
  intent: string;
  kind: GroupKind;
  risk: Risk;
  riskReasons: string[];
  verify: string[];
  /** Ordered by path, then new-file line. */
  hunkIds: string[];
  /** Keys of groups that should be read first. */
  dependsOn: string[];
  autoClear: boolean;
  unclassified?: boolean;
}

export interface Analysis {
  summary: string;
  groups: AnalysisGroup[];
  unrelatedOrSuspicious: string[];
  /** The model output was unusable; groups are a deterministic directory grouping. */
  fallback: boolean;
  /** Hunks the model failed to place (now in "Unclassified — must read"). */
  backfilled: number;
  /** The PR was too large for one call, so a map-reduce was used. */
  mapReduce: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  usage?: LlmUsage;
  durationMs: number;
}
