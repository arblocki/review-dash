export type KeyAction =
  | 'nextHunk'
  | 'prevHunk'
  | 'nextGroup'
  | 'prevGroup'
  | 'toggleReviewed'
  | 'comment'
  | 'help'
  | 'escape';

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  /** A DOM event target (typed loosely so plain objects work in tests). */
  target?: unknown;
}

export const SHORTCUTS: { keys: string; action: KeyAction | 'focusing'; label: string }[] = [
  { keys: 'j / k', action: 'nextHunk', label: 'Next / previous hunk or file' },
  { keys: 'J / K', action: 'nextGroup', label: 'Next / previous group' },
  { keys: 'r', action: 'toggleReviewed', label: 'Toggle reviewed on the focused hunk or file' },
  { keys: 'c', action: 'comment', label: 'Comment on the focused hunk' },
  { keys: '?', action: 'help', label: 'Show or hide this help' },
  { keys: 'Esc', action: 'escape', label: 'Close dialogs' },
];

/** True when typing should go to the element rather than trigger a shortcut. */
export function isTypingTarget(target: KeyEventLike['target']): boolean {
  if (!target) return false;
  const t = target as { tagName?: string; isContentEditable?: boolean };
  if (t.isContentEditable) return true;
  const tag = t.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const KEYS: Record<string, KeyAction> = {
  j: 'nextHunk',
  k: 'prevHunk',
  J: 'nextGroup',
  K: 'prevGroup',
  r: 'toggleReviewed',
  c: 'comment',
  '?': 'help',
  Escape: 'escape',
};

/** The shortcut a key event triggers, or null (modifiers held, typing in a field, unknown key). */
export function keyAction(e: KeyEventLike): KeyAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  return KEYS[e.key] ?? null;
}

/**
 * Index after moving `delta` from `current` in a list of `length`, clamped to the ends.
 * With nothing focused (`current` -1) forward goes to the first and backward to the last.
 */
export function stepIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}

/** The id after `current` in `ids` (see `stepIndex`); null for an empty list. */
export function stepId(ids: string[], current: string | null, delta: 1 | -1): string | null {
  const i = stepIndex(current === null ? -1 : ids.indexOf(current), ids.length, delta);
  return ids[i] ?? null;
}
