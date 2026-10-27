import { useMemo } from 'react';
import { groupOptionLabel } from '../lib/groups';
import { groupProgress } from '../lib/progress';
import { useReviewState } from '../reviewState';
import type { AnalysisGroup } from '../types';

/**
 * Group selector for screens narrower than `md`, where the rail is hidden. Sits at the top of
 * the main pane; the desktop rail stays the primary navigation.
 */
export function GroupPicker({
  groups,
  selectedKey,
  onSelect,
}: {
  groups: AnalysisGroup[];
  selectedKey: string | undefined;
  onSelect(key: string): void;
}) {
  const { knownItemIds, fileKeys, status } = useReviewState();
  const progress = useMemo(
    () => groupProgress(groups, fileKeys, knownItemIds, status),
    [groups, fileKeys, knownItemIds, status],
  );
  if (groups.length === 0) return null;
  return (
    <label className="mb-3 flex items-center gap-2 text-sm md:hidden">
      <span className="shrink-0 font-semibold">Group</span>
      <select
        aria-label="Select group"
        className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
        value={selectedKey ?? ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        {groups.map((g) => (
          <option key={g.key} value={g.key}>
            {groupOptionLabel(g, progress.get(g.key))}
          </option>
        ))}
      </select>
    </label>
  );
}
