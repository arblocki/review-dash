import { fileReviewKey } from '../../core/review-items';
import type { AnalysisGroup, ParsedFile } from '../types';

/** path -> review-item key for every file that has no hunks. */
export function fileKeyMap(files: ParsedFile[], headSha: string): Map<string, string> {
  return new Map(
    files.filter((f) => f.hunks.length === 0).map((f) => [f.path, fileReviewKey(f, headSha)]),
  );
}

/** A group's review items that exist in the PR: its hunk ids, then its hunkless files' keys. */
export function groupItemIds(
  group: Pick<AnalysisGroup, 'hunkIds' | 'files'>,
  fileKeys: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): string[] {
  const keys = group.files.flatMap((p) => fileKeys.get(p) ?? []);
  return [...group.hunkIds, ...keys].filter((id) => known.has(id));
}

/** "3/5 hunks", "2/2 files" or "4/7 hunks + files", by what the group holds. */
export function itemsLabel(total: number, hasHunks: boolean, hasFiles: boolean): string {
  if (hasHunks && hasFiles) return 'hunks + files';
  if (hasFiles) return total === 1 ? 'file' : 'files';
  return total === 1 ? 'hunk' : 'hunks';
}
