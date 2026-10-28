import type { DiffLine, Hunk, LineRange } from '../types';
import type { DiffSection } from './sections';

/**
 * Drops hunks for which `hide` is true, and files left with no hunks. A section that never had
 * hunks (a hunkless file) is kept unless `hideFile(path)` is true.
 */
export function filterSections(
  sections: DiffSection[],
  hide: (hunk: Hunk) => boolean,
  hideFile: (path: string) => boolean = () => false,
): DiffSection[] {
  const out: DiffSection[] = [];
  for (const s of sections) {
    if (s.hunks.length === 0) {
      if (!hideFile(s.file.path)) out.push(s);
      continue;
    }
    const hunks = s.hunks.filter((h) => !hide(h));
    if (hunks.length > 0) out.push(hunks.length === s.hunks.length ? s : { ...s, hunks });
  }
  return out;
}

/** Hunk ids in display order. */
export function sectionHunkIds(sections: DiffSection[]): string[] {
  return sections.flatMap((s) => s.hunks.map((h) => h.id));
}

/** Review-item ids in display order: hunk ids, or the file key for a hunkless section. */
export function sectionItemIds(
  sections: DiffSection[],
  fileKeys: ReadonlyMap<string, string>,
): string[] {
  return sections.flatMap((s) =>
    s.hunks.length > 0 ? s.hunks.map((h) => h.id) : (fileKeys.get(s.file.path) ?? []),
  );
}

/** The first added or deleted line of a hunk as a comment range (falls back to the first line). */
export function firstChangedRange(hunk: Hunk): LineRange | null {
  const line: DiffLine | undefined = hunk.lines.find((l) => l.type !== 'context') ?? hunk.lines[0];
  if (!line) return null;
  if (line.type === 'del')
    return line.oldLine === undefined ? null : { side: 'LEFT', line: line.oldLine };
  return line.newLine === undefined ? null : { side: 'RIGHT', line: line.newLine };
}
