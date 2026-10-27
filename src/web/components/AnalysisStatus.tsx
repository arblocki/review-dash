import { useAnalysis } from '../analysis';
import { describeAnalysisError, type ViewMode } from '../lib/groups';
import { providerNotice } from '../lib/providerNotice';

/** Skeleton shown in the main pane of a grouped view while analysis is running. */
export function AnalysisSkeleton() {
  const { elapsedS } = useAnalysis();
  return (
    <div aria-busy="true" aria-label="Analyzing pull request">
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
        Grouping hunks… {elapsedS}s elapsed (usually 10–60s). The By file view works meanwhile.
      </p>
      <div className="space-y-3">
        <div className="h-8 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-4 w-full animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-32 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
      </div>
    </div>
  );
}

/** Analysis failure with a hint and a way back to the By file view. */
export function AnalysisError({ view, onView }: { view: ViewMode; onView(v: ViewMode): void }) {
  const { error, reanalyze, loading } = useAnalysis();
  if (!error) return null;
  const info = describeAnalysisError(error.code, error.message);
  return (
    <div
      role="alert"
      className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      <div className="font-semibold">{info.title}</div>
      <p className="mt-1">{info.hint}</p>
      <p className="mt-1 font-mono text-xs opacity-80">{error.message}</p>
      <div className="mt-2 flex gap-3">
        <button type="button" className="underline" disabled={loading} onClick={reanalyze}>
          Retry
        </button>
        {view !== 'file' && (
          <button type="button" className="underline" onClick={() => onView('file')}>
            Review by file instead
          </button>
        )}
      </div>
    </div>
  );
}

/** Says which provider produced the displayed groups while a switch is running or has failed. */
export function ProviderNotice() {
  const { result, providers, choice, loading, error } = useAnalysis();
  const requested = choice ?? providers?.current ?? null;
  const text = providerNotice({
    displayed: result ? { provider: result.analysis.provider, model: result.analysis.model } : null,
    requested,
    loading,
    error: error?.message ?? null,
  });
  if (!text) return null;
  return (
    <p
      role="status"
      data-testid="provider-notice"
      className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      {text}
    </p>
  );
}

/** Slim banner above the file view while analysis runs in the background. */
export function AnalysisBanner() {
  const { loading, elapsedS, stale, result } = useAnalysis();
  if (stale) {
    const sha = result?.headSha?.slice(0, 7) ?? '';
    return (
      <p
        role="status"
        data-testid="stale-banner"
        className="mb-3 flex items-center gap-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      >
        {loading && (
          <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        Analysis is for an older version of this PR ({sha}){loading ? ' — re-analyzing…' : '.'}{' '}
        Showing the By file view meanwhile.
      </p>
    );
  }
  if (!loading) return null;
  return (
    <p className="mb-3 flex items-center gap-2 rounded bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-200">
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      Grouping in the background… {elapsedS}s. Keep reviewing by file; groups appear when ready.
    </p>
  );
}
