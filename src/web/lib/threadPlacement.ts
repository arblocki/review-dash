import type { Hunk, ReviewThread } from '../types';
import { findChangeKey, findHunk, toRdvHunks } from './diffModel';

export interface ThreadPlacement {
  /** Threads whose line is in a rendered hunk; the diff shows them under that line. */
  inline: ReviewThread[];
  /** Threads that can't attach to a rendered line; shown in the file's Discussion section. */
  fileLevel: ReviewThread[];
}

/**
 * Splits a file's threads between the diff lines being rendered (`shown`) and a file-level
 * section. Threads on lines of `hidden` hunks (hunks shown by another card) are dropped; they
 * render there. Lines hidden by whitespace filtering are in neither list, so they fall to
 * the file level instead of disappearing.
 */
export function placeThreads(
  threads: ReviewThread[],
  shown: Hunk[],
  hidden: Hunk[] = [],
): ThreadPlacement {
  const rdv = toRdvHunks(shown);
  const inline: ReviewThread[] = [];
  const fileLevel: ReviewThread[] = [];
  for (const t of threads) {
    const pos = t.line === null ? null : { side: t.diffSide, line: t.line };
    if (pos && findChangeKey(rdv, pos)) inline.push(t);
    else if (!pos || !findHunk(hidden, pos)) fileLevel.push(t);
  }
  return { inline, fileLevel };
}
