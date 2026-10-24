import { describe, expect, it } from 'vitest';
import { isTypingTarget, keyAction, stepId, stepIndex } from './keyboard';

describe('isTypingTarget', () => {
  it('detects fields and contenteditable', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('keyAction', () => {
  const body = { tagName: 'BODY' };
  it('maps keys to actions', () => {
    expect(keyAction({ key: 'j', target: body })).toBe('nextHunk');
    expect(keyAction({ key: 'K', target: body })).toBe('prevGroup');
    expect(keyAction({ key: 'r', target: body })).toBe('toggleReviewed');
    expect(keyAction({ key: '?', target: body })).toBe('help');
    expect(keyAction({ key: 'Escape', target: body })).toBe('escape');
    expect(keyAction({ key: 'x', target: body })).toBeNull();
  });
  it('ignores typing, modifiers, and handled events', () => {
    expect(keyAction({ key: 'j', target: { tagName: 'TEXTAREA' } })).toBeNull();
    expect(keyAction({ key: 'r', ctrlKey: true, target: body })).toBeNull();
    expect(keyAction({ key: 'r', metaKey: true, target: body })).toBeNull();
    expect(keyAction({ key: 'j', defaultPrevented: true, target: body })).toBeNull();
  });
});

describe('stepIndex / stepId', () => {
  it('starts at the ends when nothing is focused', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
  });
  it('clamps at both ends', () => {
    expect(stepIndex(2, 3, 1)).toBe(2);
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(stepIndex(1, 3, 1)).toBe(2);
  });
  it('handles an empty list', () => {
    expect(stepIndex(0, 0, 1)).toBe(-1);
    expect(stepId([], null, 1)).toBeNull();
  });
  it('steps ids, treating an unknown current as nothing focused', () => {
    expect(stepId(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(stepId(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(stepId(['a', 'b', 'c'], 'gone', 1)).toBe('a');
    expect(stepId(['a', 'b', 'c'], null, -1)).toBe('c');
  });
});
