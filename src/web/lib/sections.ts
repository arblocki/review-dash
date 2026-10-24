import type { Hunk, ParsedFile } from '../types';

/** A file header plus the subset of its hunks to render (a group card is a list of these). */
export interface DiffSection {
  file: ParsedFile;
  hunks: Hunk[];
  /** DOM id for the file header; set only where scroll-to-file should land. */
  anchorId?: string;
}

/** Sections for a set of hunk ids, keeping file order and hunk order within each file. */
export function sectionsFromHunkIds(files: ParsedFile[], hunkIds: Iterable<string>): DiffSection[] {
  const wanted = new Set(hunkIds);
  const out: DiffSection[] = [];
  for (const file of files) {
    const hunks = file.hunks.filter((h) => wanted.has(h.id));
    if (hunks.length > 0) out.push({ file, hunks });
  }
  return out;
}
