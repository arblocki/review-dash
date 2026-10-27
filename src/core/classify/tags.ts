export const TAGS = [
  'lockfile',
  'generated',
  'snapshot',
  'vendor',
  'test',
  'docs',
  'config',
  'ci',
  'migration',
  'deps',
  'rename-only',
  'whitespace-only',
  'comment-only',
] as const;

export type Tag = (typeof TAGS)[number];

/**
 * Tags whose changes need no human reading: they skip the LLM and go to "Mechanical changes".
 * `whitespace-only` and `comment-only` are deliberately absent: they are line-based hints, and
 * line-based checks cannot see multi-line string context (template literals, heredocs), where
 * indentation, blank lines and `// note` lines are part of the value.
 */
export const MECHANICAL_TAGS: readonly Tag[] = [
  'lockfile',
  'generated',
  'snapshot',
  'vendor',
  'rename-only',
];

export function isMechanical(tags: readonly Tag[]): boolean {
  return tags.some((t) => MECHANICAL_TAGS.includes(t));
}

/** Tags that are safe to auto-clear when every hunk of a group has one of them. */
export const AUTO_CLEAR_TAGS: readonly Tag[] = [...MECHANICAL_TAGS, 'docs'];

export function isAutoClearable(tags: readonly Tag[]): boolean {
  return tags.some((t) => AUTO_CLEAR_TAGS.includes(t));
}
