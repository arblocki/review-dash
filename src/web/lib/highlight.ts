import { refractor } from 'refractor';
import { tokenize, type HunkData, type HunkTokens, type TokenizeOptions } from 'react-diff-view';

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  lua: 'lua',
  r: 'r',
};

const BY_FILENAME: Record<string, string> = { makefile: 'makefile' };

/** Refractor language for a path, or undefined when we don't know (or didn't bundle) it. */
export function languageForPath(path: string): string | undefined {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const lang = BY_FILENAME[name] ?? BY_EXTENSION[ext];
  return lang && refractor.registered(lang) ? lang : undefined;
}

// react-diff-view predates refractor 4+: it expects `highlight` to return the node array
// (refractor 3), whereas newer versions return a hast root.
const v3Compat = {
  highlight: (code: string, lang: string) => refractor.highlight(code, lang).children,
} as unknown as Extract<TokenizeOptions, { highlight: true }>['refractor'];

const MAX_HIGHLIGHT_CHANGES = 6000;

/** Syntax tokens for hunks, or undefined when the language is unknown or the diff is huge. */
export function highlightHunks(
  hunks: HunkData[],
  language: string | undefined,
): HunkTokens | undefined {
  if (!language || hunks.length === 0) return undefined;
  if (hunks.reduce((n, h) => n + h.changes.length, 0) > MAX_HIGHLIGHT_CHANGES) return undefined;
  try {
    return tokenize(hunks, { highlight: true, refractor: v3Compat, language });
  } catch {
    return undefined; // never let a tokenizer problem break the diff
  }
}
