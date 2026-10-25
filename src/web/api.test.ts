import { describe, expect, it } from 'vitest';
import { resolveToken } from './api.js';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('resolveToken', () => {
  it('uses and stores the token from the hash', () => {
    const s = memoryStorage();
    expect(resolveToken('#token=abc', s)).toBe('abc');
    expect(s.getItem('review-dash-token')).toBe('abc');
  });

  it('survives a refresh (empty hash, same storage)', () => {
    const s = memoryStorage();
    resolveToken('#token=abc', s);
    expect(resolveToken('', s)).toBe('abc');
  });

  it('a new hash overrides the stored token', () => {
    const s = memoryStorage();
    resolveToken('#token=old', s);
    expect(resolveToken('#token=new', s)).toBe('new');
    expect(resolveToken('', s)).toBe('new');
  });

  it('returns empty string with no hash and no storage', () => {
    expect(resolveToken('', undefined)).toBe('');
    expect(resolveToken('', memoryStorage())).toBe('');
  });

  it('degrades gracefully when storage throws', () => {
    expect(resolveToken('#token=abc', throwing)).toBe('abc');
    expect(resolveToken('', throwing)).toBe('');
  });
});
