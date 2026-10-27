export type FileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export type LineType = 'add' | 'del' | 'context';

export interface DiffLine {
  type: LineType;
  /** Line text without the leading +/-/space marker. */
  content: string;
  oldLine?: number;
  newLine?: number;
  /** True when followed by "\ No newline at end of file". */
  noNewline?: boolean;
}

export interface Hunk {
  id: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The raw `@@ -a,b +c,d @@ section` line. */
  header: string;
  lines: DiffLine[];
}

/** File entry as returned by `GET /pulls/{n}/files` (the fields we use). */
export interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes?: number;
  patch?: string;
  /** Blob SHA of the file at the PR head (GitHub's `sha` field). */
  sha?: string;
}

export interface ParsedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** GitHub omitted the patch for a file that has changes (too large). */
  patchMissing: boolean;
  /** No patch and no line changes: a binary file (or empty file). */
  binary: boolean;
  /** Blob SHA at the PR head: identifies a hunkless file's content across pushes. */
  blobSha?: string;
  hunks: Hunk[];
}

export type Side = 'LEFT' | 'RIGHT';

export interface LineRange {
  line: number;
  side: Side;
  startLine?: number;
  startSide?: Side;
}
