import { describe, expect, it } from 'vitest';
import { createGitHubClient } from './client.js';
import { resolveToken } from './token.js';
import type { GraphqlLike, RestLike } from './types.js';

const ref = { owner: 'o', repo: 'r', number: 1 };
const noGql: GraphqlLike = async () => ({});

describe('resolveToken', () => {
  it('prefers gh, then env, else throws', async () => {
    expect(await resolveToken({ GITHUB_TOKEN: 'env' }, async () => 'gh-token\n')).toBe('gh-token');
    const fail = async () => {
      throw new Error('no gh');
    };
    expect(await resolveToken({ GITHUB_TOKEN: 'env' }, fail)).toBe('env');
    await expect(resolveToken({}, fail)).rejects.toThrow(/No GitHub token/);
    expect(await resolveToken({ GITHUB_TOKEN: 'env' }, async () => '  ')).toBe('env');
  });
});

describe('github client', () => {
  it('falls back to the full diff once for files missing a patch', async () => {
    const calls: { route: string; params?: Record<string, unknown> }[] = [];
    const rest: RestLike = {
      async request(route, params) {
        calls.push({ route, params });
        if (route.endsWith('/files')) {
          return {
            data: [
              {
                filename: 'a.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: '@@ -1 +1 @@\n+x',
              },
              { filename: 'big1.ts', status: 'modified', additions: 5, deletions: 5, changes: 10 },
              { filename: 'big2.ts', status: 'modified', additions: 5, deletions: 5, changes: 10 },
              { filename: 'bin.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
            ],
          };
        }
        return {
          data:
            'diff --git a/big1.ts b/big1.ts\n--- a/big1.ts\n+++ b/big1.ts\n@@ -1 +1 @@\n-a\n+b\n' +
            'diff --git a/big2.ts b/big2.ts\n--- a/big2.ts\n+++ b/big2.ts\n@@ -2 +2 @@\n-c\n+d\n',
        };
      },
    };
    const files = await createGitHubClient({ rest, gql: noGql }).fetchFiles(ref);
    expect(files.find((f) => f.filename === 'big1.ts')?.patch).toBe('@@ -1 +1 @@\n-a\n+b\n');
    expect(files.find((f) => f.filename === 'big2.ts')?.patch).toContain('@@ -2 +2 @@');
    expect(files.find((f) => f.filename === 'bin.png')?.patch).toBeUndefined();
    const diffCalls = calls.filter((c) =>
      (c.params?.headers as { accept?: string } | undefined)?.accept?.includes('diff'),
    );
    expect(diffCalls).toHaveLength(1);
  });

  it('paginates files', async () => {
    let pages = 0;
    const rest: RestLike = {
      async request(_route, params) {
        pages++;
        const n = params?.page === 1 ? 100 : 3;
        return {
          data: Array.from({ length: n }, (_, i) => ({
            filename: `f${params?.page}-${i}`,
            status: 'added',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -0,0 +1 @@\n+x',
          })),
        };
      },
    };
    const files = await createGitHubClient({ rest, gql: noGql }).fetchFiles(ref);
    expect(files).toHaveLength(103);
    expect(pages).toBe(2);
  });

  it('decodes and caches file content by path and sha', async () => {
    let n = 0;
    const rest: RestLike = {
      async request() {
        n++;
        return { data: { encoding: 'base64', content: Buffer.from('héllo').toString('base64') } };
      },
    };
    const c = createGitHubClient({ rest, gql: noGql });
    expect(await c.fetchFileContent(ref, 'a.ts', 'sha1')).toBe('héllo');
    await c.fetchFileContent(ref, 'a.ts', 'sha1');
    expect(n).toBe(1);
    await c.fetchFileContent(ref, 'a.ts', 'sha2');
    expect(n).toBe(2);
  });

  it('normalizes GraphQL review threads across pages', async () => {
    const gql: GraphqlLike = async (_q, vars) => {
      const first = vars.after === null;
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: first, endCursor: 'c1' },
              nodes: [
                {
                  id: first ? 't1' : 't2',
                  isResolved: false,
                  isOutdated: false,
                  path: 'a.ts',
                  line: 3,
                  originalLine: 3,
                  diffSide: 'RIGHT',
                  startLine: null,
                  comments: {
                    nodes: [
                      {
                        id: 'C1',
                        databaseId: 7,
                        author: { login: 'bob' },
                        body: 'x',
                        createdAt: 'now',
                        url: 'u',
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
    };
    const threads = await createGitHubClient({
      rest: { request: async () => ({ data: {} }) },
      gql,
    }).fetchReviewThreads(ref);
    expect(threads.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(threads[0]?.comments[0]).toMatchObject({ databaseId: 7, author: 'bob' });
  });

  it('pages through comments of a thread with more than 100', async () => {
    const comment = (n: number) => ({
      id: `C${n}`,
      databaseId: n,
      author: { login: 'bob' },
      body: `b${n}`,
      createdAt: 'now',
      url: 'u',
    });
    const queries: Record<string, unknown>[] = [];
    const gql: GraphqlLike = async (q, vars) => {
      queries.push(vars);
      if (q.includes('node(id')) {
        return {
          node: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [comment(101), comment(102)],
            },
          },
        };
      }
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'T1',
                  path: 'a.ts',
                  diffSide: 'RIGHT',
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: 'cc1' },
                    nodes: Array.from({ length: 100 }, (_, i) => comment(i + 1)),
                  },
                },
                {
                  id: 'T2',
                  path: 'b.ts',
                  diffSide: 'RIGHT',
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [comment(500)],
                  },
                },
              ],
            },
          },
        },
      };
    };
    const threads = await createGitHubClient({
      rest: { request: async () => ({ data: {} }) },
      gql,
    }).fetchReviewThreads(ref);
    expect(threads[0]?.comments.map((c) => c.databaseId)).toEqual(
      Array.from({ length: 102 }, (_, i) => i + 1),
    );
    expect(threads[1]?.comments).toHaveLength(1);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual({ id: 'T1', after: 'cc1' });
  });

  it('posts reviews with commit_id', async () => {
    let seen: Record<string, unknown> | undefined;
    const rest: RestLike = {
      async request(_r, params) {
        seen = params;
        return { data: { id: 5, html_url: 'u' } };
      },
    };
    const res = await createGitHubClient({ rest, gql: noGql }).submitReview(ref, {
      headSha: 'h',
      event: 'COMMENT',
      body: 'b',
      comments: [],
    });
    expect(res).toEqual({ id: 5, url: 'u' });
    expect(seen).toMatchObject({ commit_id: 'h', event: 'COMMENT', pull_number: 1 });
  });
});

describe('github client compare', () => {
  it('maps commits and files, and returns undefined on 404/422', async () => {
    const calls: string[] = [];
    const rest: RestLike = {
      async request(route, params) {
        calls.push(`${route} ${String(params?.basehead)}`);
        if (params?.basehead === 'gone...new') {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        if (params?.basehead === 'bad...new') {
          throw Object.assign(new Error('Unprocessable'), { status: 422 });
        }
        if (params?.basehead === 'boom...new') {
          throw Object.assign(new Error('boom'), { status: 500 });
        }
        return {
          data: {
            commits: [
              {
                sha: 'c1',
                author: { login: 'octocat' },
                commit: { message: 'fix', author: { name: 'O', date: '2026-01-01T00:00:00Z' } },
              },
            ],
            files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
          },
        };
      },
    };
    const gh = createGitHubClient({ rest, gql: noGql });
    expect(await gh.compareCommits(ref, 'old', 'new')).toEqual({
      commits: [{ sha: 'c1', message: 'fix', author: 'octocat', date: '2026-01-01T00:00:00Z' }],
      files: ['a.ts', 'b.ts'],
    });
    expect(calls[0]).toBe('GET /repos/{owner}/{repo}/compare/{basehead} old...new');
    expect(await gh.compareCommits(ref, 'gone', 'new')).toBeUndefined();
    expect(await gh.compareCommits(ref, 'bad', 'new')).toBeUndefined();
    await expect(gh.compareCommits(ref, 'boom', 'new')).rejects.toThrow('boom');
  });
});
