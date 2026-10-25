import { describe, expect, it } from 'vitest';
import { formatPrRef, parsePrRef } from './pr-ref.js';

const expected = { owner: 'octocat', repo: 'hello-world', number: 123 };

describe('parsePrRef', () => {
  it('parses owner/repo#number', () => {
    expect(parsePrRef('octocat/hello-world#123')).toEqual(expected);
  });

  it('parses a pull request URL', () => {
    expect(parsePrRef('https://github.com/octocat/hello-world/pull/123')).toEqual(expected);
  });

  it('accepts URL suffixes, query strings and fragments', () => {
    expect(parsePrRef('https://github.com/octocat/hello-world/pull/123/files?w=1#diff')).toEqual(
      expected,
    );
  });

  it('allows dots, dashes and underscores in names', () => {
    expect(parsePrRef('a.b/c_d-e#1')).toEqual({ owner: 'a.b', repo: 'c_d-e', number: 1 });
  });

  it('trims whitespace', () => {
    expect(parsePrRef('  octocat/hello-world#123\n')).toEqual(expected);
  });

  it.each([
    '',
    'octocat/hello-world',
    'octocat/hello-world#',
    'octocat/hello-world#0',
    'octocat/hello-world#abc',
    'octocat#123',
    'a/b/c#1',
    'https://example.com/octocat/hello-world/pull/123',
    'http://github.com/octocat/hello-world/pull/123',
    'https://github.com/octocat/hello-world/issues/123',
    'https://github.com/octocat/hello-world/pull/',
  ])('rejects %j', (input) => {
    expect(parsePrRef(input)).toBeNull();
  });
});

describe('formatPrRef', () => {
  it('round-trips', () => {
    expect(formatPrRef(expected)).toBe('octocat/hello-world#123');
  });
});
