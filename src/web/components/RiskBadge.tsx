import { riskBadge, type BadgeTone } from '../lib/groups';
import type { AnalysisGroup } from '../types';

const TONE: Record<BadgeTone, string> = {
  high: 'bg-red-600 text-white',
  medium: 'bg-amber-500 text-white',
  low: 'bg-green-600 text-white',
  auto: 'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  unclassified: 'border border-red-600 bg-transparent text-red-600 dark:text-red-400',
};

export function RiskBadge({
  group,
}: {
  group: Pick<AnalysisGroup, 'risk' | 'autoClear' | 'unclassified'>;
}) {
  const b = riskBadge(group);
  return (
    <span
      className={`inline-block w-11 shrink-0 rounded px-1 py-0.5 text-center font-mono text-[10px] leading-none font-bold ${TONE[b.tone]}`}
    >
      {b.label}
    </span>
  );
}
