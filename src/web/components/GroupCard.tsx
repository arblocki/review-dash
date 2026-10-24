import { useMemo, useState } from 'react';
import { groupByKey, verifyId } from '../lib/groups';
import { sectionsFromHunkIds } from '../lib/sections';
import { useReview } from '../state';
import type { AnalysisGroup } from '../types';
import { HunkList } from './HunkList';
import { RiskBadge } from './RiskBadge';

/**
 * Main-pane card for one group. Mount with `key={group.key}` so collapse state resets per group.
 * Slots for the next layer: a progress count next to the title, a per-hunk reviewed checkbox in
 * the hunk list (FileDiff), and `checked`/`onToggleVerify` backed by persisted state.
 */
export function GroupCard({
  group,
  allGroups,
  checked,
  onToggleVerify,
  onSelect,
}: {
  group: AnalysisGroup;
  allGroups: AnalysisGroup[];
  /** Checked verify items, by `verifyId(group.key, index)`. */
  checked: ReadonlySet<string>;
  onToggleVerify(id: string): void;
  onSelect(key: string): void;
}) {
  const { files } = useReview();
  const [expanded, setExpanded] = useState(!group.autoClear);
  const sections = useMemo(() => sectionsFromHunkIds(files, group.hunkIds), [files, group.hunkIds]);
  const byKey = useMemo(() => groupByKey(allGroups), [allGroups]);
  const deps = group.dependsOn.map((k) => byKey.get(k)).filter((g): g is AnalysisGroup => !!g);
  const shown = sections.reduce((n, s) => n + s.hunks.length, 0);

  return (
    <article>
      <div className="rounded border border-gray-200 p-4 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-2">
          <RiskBadge group={group} />
          <h2 className="min-w-0 flex-1 text-lg font-semibold">{group.title}</h2>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            {group.kind}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {group.hunkIds.length} {group.hunkIds.length === 1 ? 'hunk' : 'hunks'}
          </span>
        </div>
        {group.intent && (
          <p className="mt-2 text-sm">
            <span className="font-semibold">Intent: </span>
            {group.intent}
          </p>
        )}
        {group.riskReasons.length > 0 && (
          <div className="mt-2 text-sm">
            <div className="font-semibold">Why risky</div>
            <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
              {group.riskReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {group.verify.length > 0 && (
          <div className="mt-2 text-sm">
            <div className="font-semibold">Verify</div>
            <ul className="space-y-0.5">
              {group.verify.map((v, i) => {
                const id = verifyId(group.key, i);
                return (
                  <li key={id}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checked.has(id)}
                        onChange={() => onToggleVerify(id)}
                      />
                      <span className={checked.has(id) ? 'text-gray-500 line-through' : ''}>
                        {v}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {deps.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 text-sm">
            <span className="font-semibold">Read first:</span>
            {deps.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => onSelect(d.key)}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {d.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-4">
        {expanded ? (
          <>
            {group.autoClear && (
              <button
                type="button"
                className="mb-3 text-sm text-blue-600 hover:underline dark:text-blue-400"
                onClick={() => setExpanded(false)}
              >
                Hide hunks
              </button>
            )}
            <HunkList sections={sections} />
          </>
        ) : (
          <button
            type="button"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
            onClick={() => setExpanded(true)}
          >
            Show {shown} {shown === 1 ? 'hunk' : 'hunks'}
          </button>
        )}
      </div>
    </article>
  );
}
