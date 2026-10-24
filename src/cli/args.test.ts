import { describe, expect, it } from 'vitest';
import { parseCli, UsageError } from './args.js';

describe('parseCli', () => {
  it('parses a PR ref with defaults', () => {
    expect(parseCli(['octocat/hello-world#1'])).toEqual({
      pr: { owner: 'octocat', repo: 'hello-world', number: 1 },
      provider: undefined,
      model: undefined,
      port: undefined,
      open: true,
      debug: false,
    });
  });

  it('parses flags', () => {
    const opts = parseCli([
      'https://github.com/o/r/pull/2',
      '--provider',
      'openrouter',
      '--model=m',
      '--port',
      '8080',
      '--no-open',
      '--debug',
    ]);
    expect(opts).toMatchObject({
      pr: { owner: 'o', repo: 'r', number: 2 },
      provider: 'openrouter',
      model: 'm',
      port: 8080,
      open: false,
      debug: true,
    });
  });

  it('returns help', () => {
    expect(parseCli(['--help'])).toBe('help');
  });

  it.each([[[]], [['nope']], [['a/b#1', '--port', 'x']], [['a/b#1', '--bogus']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseCli(argv)).toThrow(UsageError);
    },
  );
});
