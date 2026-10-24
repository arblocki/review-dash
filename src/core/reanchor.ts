import { indexOfLine } from './diff/lines.js';
import type { Hunk, LineRange, ParsedFile, Side } from './diff/types.js';
import type { Draft, DraftAnchor } from './store/index.js';

/** Records where a comment's lines sit inside the hunk, so it can follow the hunk later. */
export function computeAnchor(hunk: Hunk, r: LineRange): DraftAnchor | undefined {
  const index = indexOfLine(hunk, r.side, r.line);
  if (index === -1) return undefined;
  const anchor: DraftAnchor = { index, text: hunk.lines[index]!.content };
  if (r.startLine !== undefined) {
    const start = indexOfLine(hunk, r.startSide ?? r.side, r.startLine);
    if (start === -1) return undefined;
    anchor.startIndex = start;
  }
  return anchor;
}

function lineNumberAt(hunk: Hunk, index: number, side: Side): number | undefined {
  const l = hunk.lines[index];
  if (!l) return undefined;
  if (side === 'RIGHT') return l.type !== 'del' ? l.newLine : undefined;
  return l.type === 'del' ? l.oldLine : undefined;
}

export type ReanchorResult =
  | { kind: 'unchanged' }
  | { kind: 'moved'; line: number; startLine?: number }
  | { kind: 'outdated' };

/**
 * Follows a draft written against an older head onto the current diff. The draft's hunk must
 * still exist (hunk ids are content hashes); the commented line is found by its offset in
 * the hunk and must still have the same text. Anything else is outdated.
 */
export function reanchorDraft(
  d: Draft,
  files: readonly ParsedFile[],
  currentHeadSha: string,
): ReanchorResult {
  if (d.outdated || d.headSha === currentHeadSha) return { kind: 'unchanged' };
  if (!d.hunkId || !d.anchor) return { kind: 'outdated' };
  const hunk = files.flatMap((f) => f.hunks).find((h) => h.id === d.hunkId);
  if (!hunk || hunk.path !== d.path) return { kind: 'outdated' };

  const { index, startIndex, text } = d.anchor;
  if (hunk.lines[index]?.content !== text) return { kind: 'outdated' };
  const line = lineNumberAt(hunk, index, d.side);
  if (line === undefined) return { kind: 'outdated' };
  if (d.startLine === undefined) return { kind: 'moved', line };
  if (startIndex === undefined) return { kind: 'outdated' };
  const startLine = lineNumberAt(hunk, startIndex, d.startSide ?? d.side);
  if (startLine === undefined) return { kind: 'outdated' };
  return { kind: 'moved', line, startLine };
}
