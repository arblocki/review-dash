import { describe, expect, it } from 'vitest';
import { isCommentable } from './lines.js';
import { diffHash, extractFilePatch, parseFile, parsePatch } from './parse.js';
import { loadFixture } from '../testing/fakes.testutil.js';

const file = { path: 'a.ts', status: 'modified' as const };

describe('parsePatch', () => {
  it('parses multiple hunks with line numbers', () => {
    const fx = loadFixture().files[0]!;
    const hunks = parsePatch({ path: fx.filename, status: 'modified' }, fx.patch);
    expect(hunks).toHaveLength(2);
    const [h1, h2] = hunks;
    expect(h1).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 8 });
    expect(h1?.header).toBe('@@ -1,5 +1,8 @@ import x');
    expect(h1?.lines.map((l) => l.type)).toEqual([
      'context',
      'del',
      'add',
      'add',
      'context',
      'context',
      'add',
      'add',
      'context',
    ]);
    expect(h1?.lines[1]).toMatchObject({ type: 'del', oldLine: 2 });
    expect(h1?.lines[2]).toMatchObject({ type: 'add', newLine: 2 });
    expect(h2).toMatchObject({ oldStart: 20, newStart: 23 });
  });

  it('flags "No newline at end of file" on the preceding line', () => {
    const fx = loadFixture().files[0]!;
    const last = parsePatch({ path: fx.filename, status: 'modified' }, fx.patch)[1]!;
    expect(last.lines).toHaveLength(4);
    expect(last.lines[3]).toMatchObject({ content: 'd', noNewline: true });
  });

  it('handles empty and missing patches', () => {
    expect(parsePatch(file, undefined)).toEqual([]);
    expect(parsePatch(file, '')).toEqual([]);
  });

  it('treats a bare empty line inside a hunk as empty context', () => {
    const [h] = parsePatch(file, '@@ -1,3 +1,3 @@\n a\n\n-b\n+c');
    expect(h?.lines.map((l) => [l.type, l.content])).toEqual([
      ['context', 'a'],
      ['context', ''],
      ['del', 'b'],
      ['add', 'c'],
    ]);
  });

  it('defaults omitted counts to 1', () => {
    const [h] = parsePatch(file, '@@ -3 +3 @@\n-x\n+y');
    expect(h).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
    expect(h?.lines).toHaveLength(2);
  });

  it('does not mistake content that looks like a hunk header', () => {
    const [h] = parsePatch(file, '@@ -1,2 +1,2 @@\n-@@ -1 +1 @@\n+@@ -2 +2 @@\n z');
    expect(h?.lines).toHaveLength(3);
  });
});

describe('parseFile', () => {
  const raw = loadFixture().files;
  it('keeps rename info and marks pure renames as neither binary nor missing', () => {
    const f = parseFile(raw[1]!);
    expect(f).toMatchObject({
      path: 'src/hello.ts',
      oldPath: 'src/greeting.ts',
      status: 'renamed',
      binary: false,
      patchMissing: false,
      hunks: [],
    });
  });
  it('flags binary files', () => {
    expect(parseFile(raw[2]!)).toMatchObject({ binary: true, patchMissing: false });
  });
  it('flags files with changes but no patch', () => {
    expect(parseFile(raw[3]!)).toMatchObject({ binary: false, patchMissing: true, hunks: [] });
  });
  it('carries oldPath onto hunks of a renamed, edited file', () => {
    const f = parseFile({
      filename: 'b.ts',
      previous_filename: 'a.ts',
      status: 'renamed',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-x\n+y',
    });
    expect(f.hunks[0]).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', status: 'renamed' });
  });
});

describe('hunk ids', () => {
  const body = ' ctx\n-old\n+new\n ctx';
  const at = (start: number) => `@@ -${start},3 +${start},3 @@ fn()\n${body}`;

  it('is stable across line offsets and section headers', () => {
    const a = parsePatch(file, at(10))[0]!;
    const b = parsePatch(file, `@@ -500,3 +520,3 @@ other()\n${body}`)[0]!;
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('differs by path and by content', () => {
    const a = parsePatch(file, at(1))[0]!;
    expect(parsePatch({ ...file, path: 'b.ts' }, at(1))[0]!.id).not.toBe(a.id);
    expect(parsePatch(file, at(1).replace('+new', '+newer'))[0]!.id).not.toBe(a.id);
  });

  it('distinguishes a missing trailing newline', () => {
    const a = parsePatch(file, '@@ -1 +1 @@\n-x\n+y')[0]!;
    const b = parsePatch(file, '@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file')[0]!;
    expect(a.id).not.toBe(b.id);
  });

  it('disambiguates identical hunks within one file, deterministically', () => {
    const patch = `${at(1)}\n${at(40)}`;
    const [h1, h2] = parsePatch(file, patch);
    expect(h1!.id).not.toBe(h2!.id);
    expect(parsePatch(file, patch).map((h) => h.id)).toEqual([h1!.id, h2!.id]);
    // A lone copy has a different id from either duplicate, so reviewed state for one of
    // two identical hunks is never carried over to the survivor after the other is removed.
    const lone = parsePatch(file, at(7))[0]!.id;
    expect([h1!.id, h2!.id]).not.toContain(lone);
  });

  it('keeps duplicate ids stable across line shifts while the copy count is unchanged', () => {
    const before = parsePatch(file, `${at(1)}\n${at(40)}`).map((h) => h.id);
    const after = parsePatch(file, `${at(5)}\n${at(60)}`).map((h) => h.id);
    expect(after).toEqual(before);
  });

  it('changes every duplicate id when the number of copies changes', () => {
    const two = parsePatch(file, `${at(1)}\n${at(40)}`).map((h) => h.id);
    const three = parsePatch(file, `${at(1)}\n${at(40)}\n${at(80)}`).map((h) => h.id);
    expect(three.filter((id) => two.includes(id))).toEqual([]);
    expect(new Set(three).size).toBe(3);
  });
});

describe('diffHash', () => {
  it('is deterministic and changes with content', () => {
    const files = loadFixture().files.map(parseFile);
    expect(diffHash(files)).toBe(diffHash(loadFixture().files.map(parseFile)));
    const changed = loadFixture().files;
    changed[0]!.patch = changed[0]!.patch!.replace('retries = 3', 'retries = 4');
    expect(diffHash(changed.map(parseFile))).not.toBe(diffHash(files));
  });
});

describe('extractFilePatch', () => {
  const full = [
    'diff --git a/x.ts b/x.ts',
    'index 1..2 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/big.ts b/big.ts',
    'index 3..4 100644',
    '--- a/big.ts',
    '+++ b/big.ts',
    '@@ -1 +1 @@',
    '-c',
    '+d',
    '',
  ].join('\n');
  it('extracts one file section', () => {
    expect(extractFilePatch(full, 'big.ts')).toBe('@@ -1 +1 @@\n-c\n+d\n');
    expect(extractFilePatch(full, 'x.ts')).toBe('@@ -1 +1 @@\n-a\n+b\n');
  });
  it('returns undefined when absent', () => {
    expect(extractFilePatch(full, 'nope.ts')).toBeUndefined();
  });
});

describe('isCommentable', () => {
  const fx = loadFixture().files[0]!;
  const hunks = parsePatch({ path: fx.filename, status: 'modified' }, fx.patch);

  it('allows RIGHT on add/context lines and LEFT on deleted lines', () => {
    expect(isCommentable(hunks, { side: 'RIGHT', line: 2 })).toBe(true); // add
    expect(isCommentable(hunks, { side: 'RIGHT', line: 1 })).toBe(true); // context
    expect(isCommentable(hunks, { side: 'LEFT', line: 2 })).toBe(true); // del
  });

  it('rejects wrong side and lines outside hunks', () => {
    expect(isCommentable(hunks, { side: 'LEFT', line: 1 })).toBe(false); // context on LEFT
    expect(isCommentable(hunks, { side: 'RIGHT', line: 50 })).toBe(false);
    expect(isCommentable(hunks, { side: 'RIGHT', line: 12 })).toBe(false); // gap
    expect(isCommentable([], { side: 'RIGHT', line: 1 })).toBe(false);
  });

  it('requires ranges to sit inside one hunk, start before end', () => {
    expect(isCommentable(hunks, { side: 'RIGHT', line: 4, startLine: 2 })).toBe(true);
    expect(isCommentable(hunks, { side: 'RIGHT', line: 24, startLine: 2 })).toBe(false); // two hunks
    expect(isCommentable(hunks, { side: 'RIGHT', line: 2, startLine: 4 })).toBe(false); // reversed
    expect(isCommentable(hunks, { side: 'RIGHT', line: 4, startLine: 11 })).toBe(false);
  });

  it('supports ranges from a deleted line to an added line', () => {
    expect(isCommentable(hunks, { side: 'RIGHT', line: 3, startLine: 2, startSide: 'LEFT' })).toBe(
      true,
    );
  });

  it('orders cross-side ranges by position in the hunk, not by line number', () => {
    const patch = '@@ -98,4 +88,4 @@\n a\n b\n-old\n+new\n c';
    const h = parsePatch(file, patch); // context 98/88, 99/89, del 100, add 90, context 101/91
    expect(isCommentable(h, { side: 'RIGHT', line: 90, startLine: 100, startSide: 'LEFT' })).toBe(
      true,
    );
    // Same numbers, but the end is not after the start in diff order.
    expect(isCommentable(h, { side: 'LEFT', line: 100, startLine: 90, startSide: 'RIGHT' })).toBe(
      false,
    );
    // RIGHT start before a LEFT end is not a shape GitHub accepts.
    expect(isCommentable(hunks, { side: 'LEFT', line: 2, startLine: 1, startSide: 'RIGHT' })).toBe(
      false,
    );
    // LEFT start after the RIGHT end.
    expect(isCommentable(hunks, { side: 'RIGHT', line: 2, startLine: 3, startSide: 'LEFT' })).toBe(
      false,
    );
  });
});
