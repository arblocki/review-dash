import { describe, expect, it } from 'vitest';
import { parseCli, UsageError } from './args.js';

describe('parseCli', () => {
  it('parses a PR ref with defaults', () => {
    expect(parseCli(['octocat/hello-world#1'])).toEqual({
      repo: { owner: 'octocat', repo: 'hello-world' },
      pr: 1,
      provider: undefined,
      model: undefined,
      port: undefined,
      open: true,
      debug: false,
      trustPrConfig: false,
    });
    expect(parseCli(['o/r#1', '--trust-pr-config'])).toMatchObject({ trustPrConfig: true });
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
      repo: { owner: 'o', repo: 'r' },
      pr: 2,
      provider: 'openrouter',
      model: 'm',
      port: 8080,
      open: false,
      debug: true,
    });
  });

  it.each(['octocat/hello-world', 'https://github.com/octocat/hello-world'])(
    'parses a repository %j without a PR',
    (arg) => {
      const opts = parseCli([arg]);
      expect(opts).toMatchObject({ repo: { owner: 'octocat', repo: 'hello-world' } });
      expect(opts).not.toHaveProperty('pr');
    },
  );

  it('starts without a repository when given no argument', () => {
    const opts = parseCli(['--no-open']);
    expect(opts).toMatchObject({ open: false });
    expect(opts).not.toHaveProperty('repo');
    expect(opts).not.toHaveProperty('pr');
  });

  it('returns help', () => {
    expect(parseCli(['--help'])).toBe('help');
  });

  it.each([
    [['nope']],
    [['a/b', 'c/d']],
    [['a/b#1', '--port', 'x']],
    [['a/b#1', '--bogus']],
    [['a/b#1', '--provider', 'gpt']],
  ])('rejects %j', (argv) => {
    expect(() => parseCli(argv)).toThrow(UsageError);
  });
});
