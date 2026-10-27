import { describe, expect, it } from 'vitest';
import { recentRepos, rememberRepo } from './recentRepos';

function memoryStorage(initial?: string) {
  const m = new Map<string, string>();
  if (initial !== undefined) m.set('review-dash:recentRepos', initial);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe('recent repos', () => {
  it('remembers newest first, without duplicates (case-insensitive), capped at 8', () => {
    const s = memoryStorage();
    for (let i = 0; i < 10; i++) rememberRepo({ owner: 'o', repo: `r${i}` }, s);
    rememberRepo({ owner: 'O', repo: 'R5' }, s);
    const list = recentRepos(s);
    expect(list).toHaveLength(8);
    expect(list[0]).toEqual({ owner: 'O', repo: 'R5' });
    expect(list.filter((r) => r.repo.toLowerCase() === 'r5')).toHaveLength(1);
  });

  it.each(['not json', '{"a":1}', '[1, {"owner": 2}]'])('ignores bad stored data %j', (raw) => {
    expect(recentRepos(memoryStorage(raw))).toEqual([]);
  });

  it('never throws when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(recentRepos(blocked)).toEqual([]);
    expect(() => rememberRepo({ owner: 'o', repo: 'r' }, blocked)).not.toThrow();
    expect(recentRepos(undefined)).toEqual([]);
  });
});
