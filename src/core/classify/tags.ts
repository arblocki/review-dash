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

/** Tags whose changes need no human reading: they skip the LLM and go to "Mechanical changes". */
export const MECHANICAL_TAGS: readonly Tag[] = [
  'lockfile',
  'generated',
  'snapshot',
  'vendor',
  'rename-only',
  'whitespace-only',
];

export function isMechanical(tags: readonly Tag[]): boolean {
  return tags.some((t) => MECHANICAL_TAGS.includes(t));
}

/** Tags that are safe to auto-clear when every hunk of a group has one of them. */
export const AUTO_CLEAR_TAGS: readonly Tag[] = [...MECHANICAL_TAGS, 'docs', 'comment-only'];

export function isAutoClearable(tags: readonly Tag[]): boolean {
  return tags.some((t) => AUTO_CLEAR_TAGS.includes(t));
}
