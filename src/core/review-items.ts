import type { ParsedFile } from './diff/types.js';

/**
 * Review key of a file that has no hunks (rename, binary, patch too large). The blob SHA
 * identifies its content across pushes; without one the head SHA stands in.
 */
export function fileReviewKey(file: Pick<ParsedFile, 'path' | 'blobSha'>, headSha: string): string {
  return `file:${file.path}@${file.blobSha ?? headSha}`;
}

/** Every id that can be marked reviewed: hunk ids, plus the key of each hunkless file. */
export function reviewItemIds(files: readonly ParsedFile[], headSha: string): string[] {
  const ids: string[] = [];
  for (const f of files) {
    if (f.hunks.length === 0) ids.push(fileReviewKey(f, headSha));
    else for (const h of f.hunks) ids.push(h.id);
  }
  return ids;
}
