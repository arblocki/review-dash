import type { Hunk, LineRange, Side } from './types.js';

function indexOfLine(hunk: Hunk, side: Side, line: number): number {
  return hunk.lines.findIndex((l) =>
    side === 'RIGHT'
      ? (l.type === 'add' || l.type === 'context') && l.newLine === line
      : l.type === 'del' && l.oldLine === line,
  );
}

/**
 * Whether GitHub accepts an inline comment at this position: RIGHT = added/context lines
 * (new line numbers), LEFT = deleted lines (old line numbers). A multi-line range must lie
 * within a single hunk, with its start before its end in diff order (line numbers are only
 * comparable within one side). A range may start on LEFT and end on RIGHT; the reverse (RIGHT
 * start, LEFT end) is not known to anchor reliably on GitHub, so it is treated as not
 * commentable and goes in the review body rather than risk a misplaced comment.
 */
export function isCommentable(hunks: Hunk[], range: LineRange): boolean {
  const { line, side } = range;
  const startLine = range.startLine;
  const startSide = range.startSide ?? side;
  for (const hunk of hunks) {
    const end = indexOfLine(hunk, side, line);
    if (end === -1) continue;
    if (startLine === undefined) return true;
    if (startSide === 'RIGHT' && side === 'LEFT') return false;
    const start = indexOfLine(hunk, startSide, startLine);
    return start !== -1 && start <= end && (start < end || startSide === side);
  }
  return false;
}
