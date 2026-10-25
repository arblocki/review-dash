import { describe, expect, it } from 'vitest';
import type { DiffLine, Hunk, ReviewThread } from '../types';
import { hideWhitespaceOnly } from './diffModel';
import { placeThreads } from './threadPlacement';

const hunk = (id: string, start: number, lines: DiffLine[]): Hunk => ({
  id,
  path: 'f.ts',
  status: 'modified',
  oldStart: start,
  oldLines: lines.filter((l) => l.type !== 'add').length,
  newStart: start,
  newLines: lines.filter((l) => l.type !== 'del').length,
  header: `@@ -${start} +${start} @@`,
  lines,
});
const del = (n: number, content: string): DiffLine => ({ type: 'del', content, oldLine: n });
const add = (n: number, content: string): DiffLine => ({ type: 'add', content, newLine: n });

const thread = (
  id: string,
  line: number | null,
  diffSide: 'LEFT' | 'RIGHT' = 'RIGHT',
): ReviewThread => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: 'f.ts',
  line,
  originalLine: line,
  diffSide,
  startLine: null,
  comments: [],
});

const ids = (ts: ReviewThread[]) => ts.map((t) => t.id);

describe('placeThreads', () => {
  const h1 = hunk('h1', 10, [del(10, 'a'), add(10, 'b')]);

  it('attaches threads on rendered lines and sends the rest to the file level', () => {
    const p = placeThreads(
      [thread('on-add', 10), thread('on-del', 10, 'LEFT'), thread('far', 99), thread('none', null)],
      [h1],
    );
    expect(ids(p.inline)).toEqual(['on-add', 'on-del']);
    expect(ids(p.fileLevel)).toEqual(['far', 'none']);
  });

  it('puts every thread at the file level when no hunks render (binary, rename, patch missing)', () => {
    const p = placeThreads([thread('a', 10), thread('b', null)], []);
    expect(p.inline).toEqual([]);
    expect(ids(p.fileLevel)).toEqual(['a', 'b']);
  });

  it('skips threads on lines of hunks that another card shows', () => {
    const other = hunk('h2', 50, [add(50, 'x')]);
    const p = placeThreads(
      [thread('mine', 10), thread('theirs', 50), thread('nowhere', 99)],
      [h1],
      [other],
    );
    expect(ids(p.inline)).toEqual(['mine']);
    expect(ids(p.fileLevel)).toEqual(['nowhere']);
  });

  it('keeps threads on whitespace-hidden lines visible at the file level', () => {
    const ws = hunk('ws', 1, [del(1, '  foo'), add(1, 'foo')]);
    const shown = hideWhitespaceOnly([ws]);
    expect(shown).toEqual([]);
    const p = placeThreads([thread('t', 1)], shown);
    expect(ids(p.fileLevel)).toEqual(['t']);

    // With a real hunk also shown, only the whitespace-line thread moves to the file level.
    const mixed = hideWhitespaceOnly([ws, h1]);
    const q = placeThreads([thread('t', 1), thread('u', 10)], mixed);
    expect(ids(q.inline)).toEqual(['u']);
    expect(ids(q.fileLevel)).toEqual(['t']);
  });
});
