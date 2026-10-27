import { describe, expect, it } from 'vitest';
import { fnv1a8 } from './hash.js';

describe('fnv1a8', () => {
  it('matches known FNV-1a vectors', () => {
    expect(fnv1a8('')).toBe('811c9dc5');
    expect(fnv1a8('a')).toBe('e40c292c');
    expect(fnv1a8('foobar')).toBe('bf9cf968');
  });
});
