import type { AnalysisGroup, ParsedFile } from '../types';

/**
 * Review items are what the user ticks off: every hunk (by its id) plus every hunkless file
 * (no patch, binary, pure rename), which has no hunk to tick. A file's key includes its blob
 * SHA so the tick resets once the file changes; without one it falls back to the head SHA and
 * resets on every push (conservative).
 */
export function fileItemId(file: Pick<ParsedFile, 'path' | 'blobSha'>, headSha: string): string {
  return `file:${file.path}@${file.blobSha ?? headSha}`;
}

/** path -> review-item key for every file that has no hunks. */
export function fileKeyMap(files: ParsedFile[], headSha: string): Map<string, string> {
  return new Map(
    files.filter((f) => f.hunks.length === 0).map((f) => [f.path, fileItemId(f, headSha)]),
  );
}

/** Every review item in the PR: all hunk ids and the keys of all hunkless files. */
export function allItemIds(files: ParsedFile[], headSha: string): Set<string> {
  const out = new Set(files.flatMap((f) => f.hunks.map((h) => h.id)));
  for (const key of fileKeyMap(files, headSha).values()) out.add(key);
  return out;
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
