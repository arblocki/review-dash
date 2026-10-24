import { expandFromRawCode, type ChangeData, type HunkData } from 'react-diff-view';
import { isCommentable } from '../../core/diff/lines';
import type { DiffLine, Hunk, LineRange, Side } from '../../core/diff/types';

/** A commentable position: deleted lines live on LEFT (old numbering), everything else on RIGHT. */
export interface Position {
  side: Side;
  line: number;
}

// --- adapter: our hunk model -> react-diff-view ---------------------------------------------

export function toRdvChange(line: DiffLine): ChangeData {
  if (line.type === 'add') {
    return { type: 'insert', isInsert: true, content: line.content, lineNumber: line.newLine ?? 0 };
  }
  if (line.type === 'del') {
    return { type: 'delete', isDelete: true, content: line.content, lineNumber: line.oldLine ?? 0 };
  }
  return {
    type: 'normal',
    isNormal: true,
    content: line.content,
    oldLineNumber: line.oldLine ?? 0,
    newLineNumber: line.newLine ?? 0,
  };
}

export function toRdvHunk(hunk: Hunk): HunkData {
  return {
    content: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    changes: hunk.lines.map(toRdvChange),
  };
}

export function toRdvHunks(hunks: Hunk[]): HunkData[] {
  return hunks.map(toRdvHunk);
}

// --- keys and positions --------------------------------------------------------------------

/** Same scheme as react-diff-view's `getChangeKey`; keys widgets and selections. */
export function changeKey(change: ChangeData): string {
  if (change.type === 'normal') return `N${change.oldLineNumber}`;
  return `${change.type === 'insert' ? 'I' : 'D'}${change.lineNumber}`;
}

/** Side/line GitHub wants for a change: deleted -> LEFT + old line; add/context -> RIGHT + new line. */
export function changePosition(change: ChangeData): Position {
  if (change.type === 'delete') return { side: 'LEFT', line: change.lineNumber };
  if (change.type === 'insert') return { side: 'RIGHT', line: change.lineNumber };
  return { side: 'RIGHT', line: change.newLineNumber };
}

function matchesPosition(change: ChangeData, { side, line }: Position): boolean {
  if (side === 'LEFT') {
    return change.type === 'delete'
      ? change.lineNumber === line
      : change.type === 'normal' && change.oldLineNumber === line;
  }
  return change.type === 'insert'
    ? change.lineNumber === line
    : change.type === 'normal' && change.newLineNumber === line;
}

/** Widget key of the change displaying `pos`, if that line is currently rendered. */
export function findChangeKey(hunks: HunkData[], pos: Position): string | undefined {
  for (const hunk of hunks) {
    const change = hunk.changes.find((c) => matchesPosition(c, pos));
    if (change) return changeKey(change);
  }
  return undefined;
}

function flatChanges(hunks: HunkData[]): ChangeData[] {
  return hunks.flatMap((h) => h.changes);
}

/** Keys of every change from `a` to `b` inclusive, in display order (either argument order). */
export function keysBetween(hunks: HunkData[], a: string, b: string): string[] {
  const keys = flatChanges(hunks).map(changeKey);
  const i = keys.indexOf(a);
  const j = keys.indexOf(b);
  if (i === -1 || j === -1) return [];
  return keys.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * Turns an anchor/focus pair of change keys (a click, shift-click, or drag) into a GitHub
 * line range. The later line in display order is `line`/`side`; the earlier is the start.
 */
export function selectRange(hunks: HunkData[], a: string, b: string): LineRange | null {
  const changes = flatChanges(hunks);
  const keys = changes.map(changeKey);
  const i = keys.indexOf(a);
  const j = keys.indexOf(b);
  const first = changes[Math.min(i, j)];
  const last = changes[Math.max(i, j)];
  if (i === -1 || j === -1 || !first || !last) return null;
  const end = changePosition(last);
  if (i === j) return end;
  const start = changePosition(first);
  return { line: end.line, side: end.side, startLine: start.line, startSide: start.side };
}

/** The original hunk containing a position, used to tag drafts with a hunk id. */
export function findHunk(hunks: Hunk[], pos: Position): Hunk | undefined {
  return hunks.find((h) =>
    h.lines.some((l) =>
      pos.side === 'LEFT'
        ? l.type === 'del' && l.oldLine === pos.line
        : l.type !== 'del' && l.newLine === pos.line,
    ),
  );
}

/** Whether GitHub will accept this range as an inline comment (it falls inside the diff). */
export function isInlineRange(fileHunks: Hunk[], range: LineRange): boolean {
  return isCommentable(fileHunks, range);
}

// --- context expansion ---------------------------------------------------------------------

/** File text -> lines, without the phantom empty line after a trailing newline. */
export function sourceLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Collapsed region in old-file line numbers: `start` inclusive, `end` exclusive. */
export interface Gap {
  start: number;
  end: number;
}

/** Collapsed lines above `hunks[index]`, down to the previous hunk (or file start). */
export function gapBefore(hunks: HunkData[], index: number): Gap {
  const prev = hunks[index - 1];
  const next = hunks[index];
  return {
    start: prev ? prev.oldStart + prev.oldLines : 1,
    end: next ? next.oldStart : 1,
  };
}

/** Collapsed lines after the last hunk; needs the file length. */
export function gapAfter(hunks: HunkData[], totalLines: number): Gap {
  const last = hunks.at(-1);
  return { start: last ? last.oldStart + last.oldLines : 1, end: totalLines + 1 };
}

export const gapSize = (gap: Gap): number => Math.max(0, gap.end - gap.start);

export type ExpandDirection = 'up' | 'down' | 'all';

/**
 * Old-line range to reveal for a button press on `gap`, or null if nothing can be revealed.
 * 'up' reveals the lines adjacent to the hunk below the gap, 'down' those adjacent to the
 * hunk above it. `hidden` are original hunks that are not displayed (a group showing a subset
 * of a file's hunks): the range never crosses them, so changed lines are never shown as context.
 */
export function expansionRange(
  gap: Gap,
  direction: ExpandDirection,
  step = 20,
  hidden: Pick<Hunk, 'oldStart' | 'oldLines'>[] = [],
): [number, number] | null {
  const inside = hidden.filter((h) => h.oldStart < gap.end && h.oldStart + h.oldLines > gap.start);
  const lo = Math.max(gap.start, ...inside.map((h) => h.oldStart + h.oldLines));
  const hi = Math.min(gap.end, ...inside.map((h) => h.oldStart));
  let range: [number, number];
  if (direction === 'all') {
    if (inside.length > 0) return null;
    range = [gap.start, gap.end];
  } else if (direction === 'up') {
    range = [Math.max(lo, gap.end - step), gap.end];
  } else {
    range = [gap.start, Math.min(hi, gap.start + step)];
  }
  return range[0] < range[1] ? range : null;
}

/** Replays expansions (old-line ranges) onto `hunks` using the file's old text. */
export function applyExpansions(
  hunks: HunkData[],
  source: string[] | undefined,
  ranges: [number, number][],
): HunkData[] {
  if (!source || hunks.length === 0) return hunks;
  return ranges.reduce((acc, [s, e]) => expandFromRawCode(acc, source, s, e), hunks);
}

// --- whitespace ----------------------------------------------------------------------------

const squash = (s: string): string => s.replace(/\s+/g, '');

/**
 * Client-side "hide whitespace": a block of N deletions immediately followed by N additions
 * whose lines differ only in whitespace becomes context. Hunks left with no changes are dropped.
 * Line numbers are untouched, so comments on these lines still map correctly.
 */
export function hideWhitespaceOnly(hunks: Hunk[]): Hunk[] {
  const out: Hunk[] = [];
  for (const hunk of hunks) {
    const lines: DiffLine[] = [];
    let i = 0;
    while (i < hunk.lines.length) {
      const line = hunk.lines[i] as DiffLine;
      if (line.type !== 'del') {
        lines.push(line);
        i++;
        continue;
      }
      let delEnd = i;
      while (hunk.lines[delEnd]?.type === 'del') delEnd++;
      let addEnd = delEnd;
      while (hunk.lines[addEnd]?.type === 'add') addEnd++;
      const dels = hunk.lines.slice(i, delEnd);
      const adds = hunk.lines.slice(delEnd, addEnd);
      const same =
        dels.length === adds.length &&
        dels.every((d, k) => squash(d.content) === squash((adds[k] as DiffLine).content));
      if (same) {
        adds.forEach((a, k) => {
          const d = dels[k] as DiffLine;
          lines.push({
            type: 'context',
            content: a.content,
            oldLine: d.oldLine,
            newLine: a.newLine,
            ...(a.noNewline ? { noNewline: true } : {}),
          });
        });
      } else {
        lines.push(...dels, ...adds);
      }
      i = addEnd;
    }
    if (lines.some((l) => l.type !== 'context')) out.push({ ...hunk, lines });
  }
  return out;
}
