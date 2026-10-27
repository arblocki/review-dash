import type { Hunk, ParsedFile } from '../diff/types.js';
import { classifyHunk } from './hunk.js';
import { classifyPath, hasGeneratedMarker } from './paths.js';
import { isMechanical, type Tag } from './tags.js';

export * from './tags.js';
export { classifyPath, isTestPath, isGeneratedPath } from './paths.js';
export { classifyHunk, isCommentOnly, isWhitespaceOnly } from './hunk.js';
export { pairTests } from './pairing.js';

export interface ClassifiedHunk {
  hunk: Hunk;
  tags: Tag[];
  mechanical: boolean;
}

/** File-level tags: path rules, generated-code markers, and pure renames. */
export function classifyFile(file: ParsedFile): Tag[] {
  const tags = classifyPath(file.path);
  if (!tags.includes('generated') && hasGeneratedMarker(file)) tags.push('generated');
  if (
    file.status === 'renamed' &&
    file.hunks.length === 0 &&
    !file.patchMissing &&
    file.additions === 0 &&
    file.deletions === 0
  ) {
    tags.push('rename-only');
  }
  return tags;
}

/** Tags every hunk of every file (file order, then hunk order). */
export function classifyFiles(files: readonly ParsedFile[]): ClassifiedHunk[] {
  const out: ClassifiedHunk[] = [];
  for (const file of files) {
    const fileTags = classifyFile(file);
    for (const hunk of file.hunks) {
      const tags = classifyHunk(hunk, fileTags);
      out.push({ hunk, tags, mechanical: isMechanical(tags) });
    }
  }
  return out;
}
