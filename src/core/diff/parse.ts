import { createHash } from 'node:crypto';
import type { DiffLine, FileStatus, Hunk, ParsedFile, RawFile } from './types.js';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const STATUSES: readonly FileStatus[] = [
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
];

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Canonical hunk text with line numbers and the section header left out. */
function normalizeHunk(lines: DiffLine[]): string {
  const marker = { add: '+', del: '-', context: ' ' } as const;
  return lines.map((l) => `${marker[l.type]}${l.content}${l.noNewline ? '\n\\' : ''}`).join('\n');
}

interface RawHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Parses a unified-diff patch body (the `@@` sections of one file) into raw hunks. */
function parseHunks(patch: string): RawHunk[] {
  const hunks: RawHunk[] = [];
  let cur: RawHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const rows = patch.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();

  for (const row of rows) {
    const m = HUNK_HEADER.exec(row);
    if (m && (!cur || (oldLeft <= 0 && newLeft <= 0))) {
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      cur = {
        header: row,
        oldStart: Number(m[1]),
        oldLines,
        newStart: Number(m[3]),
        newLines,
        lines: [],
      };
      hunks.push(cur);
      oldLeft = oldLines;
      newLeft = newLines;
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      continue;
    }
    if (!cur) continue;
    if (row.startsWith('\\')) {
      const prev = cur.lines[cur.lines.length - 1];
      if (prev) prev.noNewline = true;
      continue;
    }
    const mark = row[0];
    const content = row.slice(1);
    if (mark === '+' && newLeft > 0) {
      cur.lines.push({ type: 'add', content, newLine: newNo++ });
      newLeft--;
    } else if (mark === '-' && oldLeft > 0) {
      cur.lines.push({ type: 'del', content, oldLine: oldNo++ });
      oldLeft--;
    } else if ((mark === ' ' || mark === undefined) && oldLeft > 0 && newLeft > 0) {
      cur.lines.push({ type: 'context', content, oldLine: oldNo++, newLine: newNo++ });
      oldLeft--;
      newLeft--;
    }
  }
  return hunks;
}

/**
 * Parses one file's patch into hunks with stable IDs.
 * ID = sha1(path + normalized content), so it survives line-number shifts. Two hunks in
 * one file with identical content get an occurrence index mixed in (in file order).
 */
export function parsePatch(
  file: { path: string; oldPath?: string; status: FileStatus },
  patch: string | undefined,
): Hunk[] {
  if (!patch) return [];
  const seen = new Map<string, number>();
  return parseHunks(patch).map((h) => {
    const base = `${file.path}\n${normalizeHunk(h.lines)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const hunk: Hunk = {
      id: sha1(n === 0 ? base : `${base}\n#${n}`),
      path: file.path,
      status: file.status,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      header: h.header,
      lines: h.lines,
    };
    if (file.oldPath) hunk.oldPath = file.oldPath;
    return hunk;
  });
}

function toStatus(s: string): FileStatus {
  return (STATUSES as readonly string[]).includes(s) ? (s as FileStatus) : 'changed';
}

/** Converts a GitHub PR file entry (with its patch, if any) into a ParsedFile. */
export function parseFile(raw: RawFile): ParsedFile {
  const status = toStatus(raw.status);
  const oldPath =
    raw.previous_filename && raw.previous_filename !== raw.filename
      ? raw.previous_filename
      : undefined;
  const changes = raw.changes ?? raw.additions + raw.deletions;
  const hasPatch = raw.patch !== undefined;
  const renameLike = status === 'renamed' || status === 'copied' || status === 'changed';
  const patchMissing = !hasPatch && changes > 0;
  const binary = !hasPatch && changes === 0 && !renameLike;
  const file: ParsedFile = {
    path: raw.filename,
    status,
    additions: raw.additions,
    deletions: raw.deletions,
    patchMissing,
    binary,
    hunks: parsePatch({ path: raw.filename, oldPath, status }, raw.patch),
  };
  if (oldPath) file.oldPath = oldPath;
  return file;
}

/** Hash over every hunk id (plus hunk-less file entries such as renames and binaries). */
export function diffHash(files: ParsedFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    if (f.hunks.length === 0) parts.push(`file:${f.oldPath ?? ''}>${f.path}:${f.status}`);
    for (const h of f.hunks) parts.push(h.id);
  }
  return sha1(parts.join('\n'));
}

/**
 * Extracts one file's patch body (from its first `@@`) out of a full multi-file diff
 * (`Accept: application/vnd.github.diff`). Returns undefined if the file is not found.
 */
export function extractFilePatch(fullDiff: string, path: string): string | undefined {
  const sections = fullDiff.split(/^(?=diff --git )/m);
  for (const section of sections) {
    const headerEnd = section.indexOf('\n');
    const header = headerEnd === -1 ? section : section.slice(0, headerEnd);
    if (!(header.endsWith(` b/${path}`) || header.endsWith(` "b/${path}"`))) continue;
    const at = section.search(/^@@ /m);
    if (at === -1) return undefined;
    return section.slice(at);
  }
  return undefined;
}
