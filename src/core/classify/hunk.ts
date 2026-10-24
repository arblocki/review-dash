import type { DiffLine, Hunk } from '../diff/types.js';
import type { Tag } from './tags.js';

const stripWs = (s: string): string => s.replace(/\s+/g, '');

/** Removed and added text are identical once whitespace is ignored (indent, re-wrap, trailing). */
export function isWhitespaceOnly(hunk: Hunk): boolean {
  let dels = '';
  let adds = '';
  let changed = 0;
  for (const l of hunk.lines) {
    if (l.type === 'del') dels += stripWs(l.content);
    else if (l.type === 'add') adds += stripWs(l.content);
    else continue;
    changed++;
  }
  return changed > 0 && dels === adds;
}

interface CommentStyle {
  line: RegExp[];
  /** Block-comment lines: openers, continuations and closers. */
  block: RegExp[];
}

const C_LIKE: CommentStyle = { line: [/^\/\//], block: [/^\/\*/, /^\*/, /^\*\//] };
const HASH: CommentStyle = { line: [/^#(?!!)/], block: [] };
const DASH: CommentStyle = { line: [/^--/], block: [] };
const HTML: CommentStyle = { line: [], block: [/^<!--/, /^-->/] };

const STYLE_BY_EXT: Record<string, CommentStyle> = {
  ts: C_LIKE,
  tsx: C_LIKE,
  js: C_LIKE,
  jsx: C_LIKE,
  mjs: C_LIKE,
  cjs: C_LIKE,
  java: C_LIKE,
  kt: C_LIKE,
  go: C_LIKE,
  rs: C_LIKE,
  c: C_LIKE,
  h: C_LIKE,
  cc: C_LIKE,
  cpp: C_LIKE,
  hpp: C_LIKE,
  cs: C_LIKE,
  swift: C_LIKE,
  scala: C_LIKE,
  php: C_LIKE,
  dart: C_LIKE,
  css: { line: [], block: C_LIKE.block },
  scss: C_LIKE,
  py: HASH,
  rb: HASH,
  sh: HASH,
  bash: HASH,
  zsh: HASH,
  yml: HASH,
  yaml: HASH,
  toml: HASH,
  pl: HASH,
  r: HASH,
  ex: HASH,
  exs: HASH,
  tf: HASH,
  sql: DASH,
  lua: DASH,
  hs: DASH,
  html: HTML,
  xml: HTML,
  vue: HTML,
  svelte: HTML,
};

function styleFor(path: string): CommentStyle | undefined {
  const base = path.split('/').pop() ?? path;
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return STYLE_BY_EXT[ext];
}

function isCommentLine(content: string, style: CommentStyle): boolean {
  const t = content.trim();
  return [...style.line, ...style.block].some((re) => re.test(t));
}

/** Every changed non-blank line is a comment. Best effort, line based. */
export function isCommentOnly(hunk: Hunk): boolean {
  const style = styleFor(hunk.path);
  if (!style) return false;
  const changed: DiffLine[] = hunk.lines.filter((l) => l.type !== 'context');
  const content = changed.filter((l) => l.content.trim() !== '');
  return content.length > 0 && content.every((l) => isCommentLine(l.content, style));
}

/** File-level tags plus content checks for one hunk. */
export function classifyHunk(hunk: Hunk, fileTags: readonly Tag[]): Tag[] {
  const tags = new Set<Tag>(fileTags);
  if (isWhitespaceOnly(hunk)) tags.add('whitespace-only');
  if (isCommentOnly(hunk)) tags.add('comment-only');
  return [...tags];
}
