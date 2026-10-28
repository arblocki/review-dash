import { describe, expect, it } from 'vitest';
import type { RepoSummary } from '../types';
import { filterRepoEntries, orderRepos } from './repoList';

const repo = (owner: string, name: string, extra: Partial<RepoSummary> = {}): RepoSummary => ({
  owner,
  name,
  description: '',
  private: false,
  archived: false,
  fork: false,
  url: '',
  pushedAt: '',
  ...extra,
});

const names = (entries: { repo: { owner: string; repo: string } }[]) =>
  entries.map((e) => `${e.repo.owner}/${e.repo.repo}`);

describe('orderRepos', () => {
  const listed = [
    repo('me', 'old', { archived: true }),
    repo('me', 'app'),
    repo('org', 'api', { description: 'Billing service' }),
  ];

  it('puts recent repos first, then listed ones with archived last', () => {
    const entries = orderRepos(listed, [{ owner: 'Org', repo: 'API' }]);
    expect(names(entries)).toEqual(['Org/API', 'me/app', 'me/old']);
    expect(entries[0]).toMatchObject({ recent: true, summary: listed[2] });
  });

  it('keeps recent repos the listing does not include', () => {
    const entries = orderRepos(listed, [{ owner: 'torvalds', repo: 'linux' }]);
    expect(entries[0]).toEqual({ repo: { owner: 'torvalds', repo: 'linux' }, recent: true });
    expect(entries).toHaveLength(4);
  });
});

describe('filterRepoEntries', () => {
  const entries = orderRepos(
    [repo('me', 'app'), repo('org', 'api', { description: 'Billing service' })],
    [],
  );

  it('returns everything for an empty query', () => {
    expect(names(filterRepoEntries(entries, ' '))).toEqual(['me/app', 'org/api']);
  });

  it('matches name and description, every term, case-insensitively', () => {
    expect(names(filterRepoEntries(entries, 'BILLING'))).toEqual(['org/api']);
    expect(names(filterRepoEntries(entries, 'org billing'))).toEqual(['org/api']);
    expect(names(filterRepoEntries(entries, 'me billing'))).toEqual([]);
  });

  it('offers a typed owner/repo or URL that is not listed', () => {
    const typed = filterRepoEntries(entries, 'https://github.com/torvalds/linux');
    expect(typed).toEqual([{ repo: { owner: 'torvalds', repo: 'linux' }, typed: true }]);
  });

  it('does not duplicate a typed repo that is listed', () => {
    expect(filterRepoEntries(entries, 'ME/APP')).toEqual([entries[0]]);
  });
});
