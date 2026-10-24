import { useEffect, useState } from 'react';
import { useAnalysis } from '../analysis';
import { usageParts, VIEW_LABELS, type ViewMode } from '../lib/groups';

const btn =
  'rounded border border-gray-300 bg-white px-2.5 py-1 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800';
const input =
  'rounded border border-gray-300 bg-white px-1.5 py-1 text-sm dark:border-gray-700 dark:bg-gray-900';

/** Second header row: view switcher, provider/model, Re-analyze, usage line, and PR summary. */
export function AnalysisBar({ view, onView }: { view: ViewMode; onView(v: ViewMode): void }) {
  const { result, loading, elapsedS, providers, choice, setChoice, reanalyze } = useAnalysis();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const analysis = result?.analysis;

  const provider = choice?.provider ?? providers?.current.provider ?? analysis?.provider ?? '';
  const appliedModel = choice?.model ?? providers?.current.model ?? analysis?.model ?? '';
  const [model, setModel] = useState(appliedModel);
  useEffect(() => setModel(appliedModel), [appliedModel]);
  const applyModel = () => {
    if (model.trim() && model.trim() !== appliedModel) setChoice({ provider, model: model.trim() });
  };

  return (
    <div className="border-t border-gray-100 px-4 py-1.5 dark:border-gray-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex overflow-hidden rounded border border-gray-300 text-sm dark:border-gray-700">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={`px-2.5 py-1 ${
                view === v
                  ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                  : 'bg-white hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800'
              }`}
              onClick={() => onView(v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        {providers && (
          <div className="flex items-center gap-1">
            <select
              aria-label="Analysis provider"
              className={input}
              value={provider}
              onChange={(e) =>
                setChoice({
                  provider: e.target.value,
                  model: providers.models[e.target.value] ?? '',
                })
              }
            >
              {providers.available.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              aria-label="Analysis model"
              className={`${input} w-52 font-mono text-xs`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={applyModel}
              onKeyDown={(e) => e.key === 'Enter' && applyModel()}
            />
          </div>
        )}
        <button type="button" className={btn} disabled={loading} onClick={reanalyze}>
          {loading ? `Analyzing… ${elapsedS}s` : 'Re-analyze'}
        </button>
        {analysis && (
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500 dark:text-gray-400">
            <span>{usageParts(analysis).join(' · ')}</span>
            {result?.cached && (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                cached
              </span>
            )}
            {analysis.fallback && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                fallback grouping
              </span>
            )}
            {analysis.backfilled > 0 && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {analysis.backfilled} {analysis.backfilled === 1 ? 'hunk' : 'hunks'} back-filled
              </span>
            )}
          </div>
        )}
      </div>
      {analysis?.summary && (
        <div className="mt-1 flex items-start gap-2 text-sm">
          <p
            className={`min-w-0 flex-1 text-gray-700 dark:text-gray-300 ${
              summaryOpen ? 'max-h-40 overflow-y-auto' : 'line-clamp-1'
            }`}
          >
            <span className="font-semibold">Summary: </span>
            {analysis.summary}
          </p>
          <button
            type="button"
            className="shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
            onClick={() => setSummaryOpen((o) => !o)}
          >
            {summaryOpen ? 'Collapse' : 'Expand'}
          </button>
        </div>
      )}
    </div>
  );
}
