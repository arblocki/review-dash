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

/** Hunkless sections (no diff body) for the given file paths, keeping file order. Unknown paths are skipped. */
export function sectionsFromFilePaths(files: ParsedFile[], paths: Iterable<string>): DiffSection[] {
  const wanted = new Set(paths);
  return files.filter((f) => wanted.has(f.path)).map((file) => ({ file, hunks: [] }));
}

/** A group's sections: its hunks first, then its hunkless files. */
export function sectionsForGroup(
  files: ParsedFile[],
  group: { hunkIds: string[]; files: string[] },
): DiffSection[] {
  return [
    ...sectionsFromHunkIds(files, group.hunkIds),
    ...sectionsFromFilePaths(files, group.files),
  ];
}
