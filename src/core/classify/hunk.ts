import type { DiffLine, Hunk } from '../diff/types.js';
import type { Tag } from './tags.js';

/** Languages where leading indentation is syntax or can change meaning; also the default for unknown types. */
const INDENT_SENSITIVE_EXT = new Set([
  'py',
  'pyi',
  'yaml',
  'yml',
  'mk',
  'haml',
  'pug',
  'slim',
  'coffee',
  'nim',
  'sass',
  'styl',
  'fs',
  'fsx',
  'hs',
  'elm',
]);

/** Extensions known to ignore leading indentation. Anything else is treated as sensitive. */
const INDENT_INSENSITIVE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'java',
  'kt',
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'scala',
  'php',
  'dart',
  'css',
  'scss',
  'less',
  'json',
  'jsonc',
  'html',
  'xml',
  'vue',
  'svelte',
  'sql',
  'toml',
  'tf',
]);

function isIndentSensitive(path: string): boolean {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (base === 'makefile' || base === 'gnumakefile') return true;
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  if (INDENT_SENSITIVE_EXT.has(ext)) return true;
  return !INDENT_INSENSITIVE_EXT.has(ext);
}

/**
 * Conservative: removed and added non-blank lines pair up 1:1 in order and each pair differs only
 * in trailing whitespace, or in leading indentation when the language is not indentation
 * sensitive; blank-line additions/removals are fine. Whitespace inside a line never qualifies.
 */
export function isWhitespaceOnly(hunk: Hunk, path: string = hunk.path): boolean {
  const sensitive = isIndentSensitive(path);
  const dels: string[] = [];
  const adds: string[] = [];
  let changed = 0;
  for (const l of hunk.lines) {
    if (l.type === 'context') continue;
    changed++;
    if (l.content.trim() === '') continue;
    (l.type === 'del' ? dels : adds).push(l.content);
  }
  if (changed === 0 || dels.length !== adds.length) return false;
  return dels.every((d, i) => {
    const a = adds[i]!;
    if (d.trimEnd() === a.trimEnd()) return true;
    return !sensitive && d.trim() === a.trim();
  });
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
  if (isWhitespaceOnly(hunk, hunk.path)) tags.add('whitespace-only');
  if (isCommentOnly(hunk)) tags.add('comment-only');
  return [...tags];
}
