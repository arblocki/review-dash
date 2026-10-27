import { parseFile } from '../diff/parse.js';
import type { ParsedFile } from '../diff/types.js';

/** Builds a ParsedFile from changed-line rows like ['-old', '+new', ' ctx'] (one hunk). */
export function mkPatch(rows: string[], start = 10): string {
  const oldN = rows.filter((r) => r[0] !== '+').length;
  const newN = rows.filter((r) => r[0] !== '-').length;
  return `@@ -${start},${oldN} +${start},${newN} @@\n${rows.join('\n')}`;
}

export function mkFile(
  path: string,
  rows: string[][] | string[],
  extra: { status?: string; previous?: string; start?: number } = {},
): ParsedFile {
  const hunks: string[][] = Array.isArray(rows[0]) ? (rows as string[][]) : [rows as string[]];
  const patch = hunks.map((h, i) => mkPatch(h, (extra.start ?? 10) + i * 100)).join('\n');
  const all = hunks.flat();
  return parseFile({
    filename: path,
    previous_filename: extra.previous,
    status: extra.status ?? 'modified',
    additions: all.filter((r) => r[0] === '+').length,
    deletions: all.filter((r) => r[0] === '-').length,
    patch,
  });
}
