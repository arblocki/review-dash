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

/**
 * For each path, the key of the one group that renders its file-level discussion: the first
 * group in display order that has any of the file's hunks or lists the file. A file split
 * across groups would otherwise repeat its unanchored threads in every one of them.
 */
export function fileThreadOwners(
  groups: { key: string; hunkIds: string[]; files: string[] }[],
  files: { path: string; hunks: { id: string }[] }[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const g of groups) {
    const hunkIds = new Set(g.hunkIds);
    const paths = new Set(g.files);
    for (const f of files) {
      if (owners.has(f.path)) continue;
      if (paths.has(f.path) || f.hunks.some((h) => hunkIds.has(h.id))) owners.set(f.path, g.key);
    }
  }
  return owners;
}
