export interface AnalysisMeta {
  headSha?: string;
  diffHash?: string;
}

export interface PrVersion {
  headSha: string;
  diffHash: string;
}

/**
 * True when the displayed analysis was computed for a different head or diff than the loaded
 * PR data. Nothing displayed, or an older server that doesn't report the version, is not stale.
 */
export function isStale(meta: AnalysisMeta | null | undefined, pr: PrVersion): boolean {
  if (!meta || meta.headSha === undefined || meta.diffHash === undefined) return false;
  return meta.headSha !== pr.headSha || meta.diffHash !== pr.diffHash;
}

/** Identity of a PR version; a request is (re)started when this differs from the last one's. */
export function prVersionKey(pr: PrVersion): string {
  return `${pr.headSha}:${pr.diffHash}`;
}

/** Whether the provider must start a new (non-forced) request for the loaded PR version. */
export function needsReanalysis(requestedKey: string | null, pr: PrVersion): boolean {
  return requestedKey !== null && requestedKey !== prVersionKey(pr);
}
