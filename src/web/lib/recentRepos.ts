import type { RepoRef } from '../types';

const KEY = 'review-dash:recentRepos';
const MAX = 8;

type RepoStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): RepoStorage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** Repositories opened recently in this browser, newest first. Never throws. */
export function recentRepos(storage = defaultStorage()): RepoRef[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RepoRef =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as RepoRef).owner === 'string' &&
        typeof (r as RepoRef).repo === 'string',
    );
  } catch {
    return [];
  }
}

/** Moves `repo` to the front of the recent list. Never throws. */
export function rememberRepo(repo: RepoRef, storage = defaultStorage()): void {
  const same = (r: RepoRef) =>
    r.owner.toLowerCase() === repo.owner.toLowerCase() &&
    r.repo.toLowerCase() === repo.repo.toLowerCase();
  const next = [
    { owner: repo.owner, repo: repo.repo },
    ...recentRepos(storage).filter((r) => !same(r)),
  ];
  try {
    storage?.setItem(KEY, JSON.stringify(next.slice(0, MAX)));
  } catch {
    // storage unavailable: the list just won't persist
  }
}
