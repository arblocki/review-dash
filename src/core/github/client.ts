import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import { extractFilePatch } from '../diff/parse.js';
import type { RawFile } from '../diff/types.js';
import type {
  GitHubClient,
  GraphqlLike,
  PrCommit,
  PrMeta,
  RestLike,
  ReviewThread,
  ThreadComment,
} from './types.js';

const PER_PAGE = 100;
const MAX_FILES = 3000;
/** Commits listed for an interdiff; more than this is reported as truncated. */
export const MAX_COMPARE_COMMITS = 1000;
/** The compare endpoint returns at most this many files and does not paginate them. */
export const COMPARE_FILE_LIMIT = 300;
const DIFF_ACCEPT = 'application/vnd.github.diff';

// Loosely typed API payloads; every field is read defensively.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine diffSide startLine
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { id databaseId author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId author { login } body createdAt url }
      }
    }
  }
}`;

function toThreadComment(c: Json): ThreadComment {
  return {
    id: c.id,
    databaseId: c.databaseId ?? null,
    author: c.author?.login ?? null,
    body: c.body ?? '',
    createdAt: c.createdAt,
    url: c.url,
  };
}

/** Builds the REST/GraphQL adapters for a token. The token never leaves these closures. */
export function createOctokitClients(token: string): { rest: RestLike; gql: GraphqlLike } {
  const octokit = new Octokit({ auth: token });
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  return {
    rest: {
      request: (route, params) =>
        octokit.request(route, params as never) as Promise<{ data: unknown }>,
    },
    gql: (query, variables) => gql(query, variables),
  };
}

export function createGitHubClient(deps: { rest: RestLike; gql: GraphqlLike }): GitHubClient {
  const { rest, gql } = deps;
  const contentCache = new Map<string, string>();
  let viewer: Promise<string> | undefined;

  async function paginate(
    route: string,
    params: Record<string, unknown>,
    max = Infinity,
  ): Promise<Json[]> {
    const all: Json[] = [];
    for (let page = 1; all.length < max; page++) {
      const { data } = await rest.request(route, { ...params, per_page: PER_PAGE, page });
      const items = data as Json[];
      all.push(...items);
      if (items.length < PER_PAGE) break;
    }
    return all.slice(0, max);
  }

  return {
    async fetchPr(ref) {
      const { data } = await rest.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
      });
      const d = data as Json;
      const meta: PrMeta = {
        title: d.title ?? '',
        body: d.body ?? '',
        author: d.user?.login ?? 'ghost',
        state: d.merged ? 'merged' : d.state === 'closed' ? 'closed' : 'open',
        url: d.html_url ?? '',
        baseSha: d.base.sha,
        baseRef: d.base.ref,
        headSha: d.head.sha,
        headRef: d.head.ref,
        additions: d.additions ?? 0,
        deletions: d.deletions ?? 0,
        changedFiles: d.changed_files ?? 0,
      };
      return meta;
    },

    async fetchFiles(ref) {
      const params = { owner: ref.owner, repo: ref.repo, pull_number: ref.number };
      const raw = await paginate(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
        params,
        MAX_FILES,
      );
      const files: RawFile[] = raw.map((f) => ({
        filename: f.filename,
        previous_filename: f.previous_filename,
        status: f.status,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        changes: f.changes ?? 0,
        patch: f.patch,
        ...(typeof f.sha === 'string' ? { sha: f.sha } : {}),
      }));
      const missing = files.filter((f) => f.patch === undefined && (f.changes ?? 0) > 0);
      if (missing.length > 0) {
        // Fetch the full diff once and pull each missing file's section out of it.
        const { data } = await rest.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          ...params,
          headers: { accept: DIFF_ACCEPT },
        });
        if (typeof data === 'string') {
          for (const f of missing) {
            const patch = extractFilePatch(data, f.filename);
            if (patch !== undefined) f.patch = patch;
          }
        }
      }
      return files;
    },

    async fetchFileContent(ref, path, sha) {
      const key = `${path}@${sha}`;
      const hit = contentCache.get(key);
      if (hit !== undefined) return hit;
      const params = { owner: ref.owner, repo: ref.repo, path, ref: sha };
      const { data } = await rest.request('GET /repos/{owner}/{repo}/contents/{path}', params);
      const d = data as Json;
      let text: string;
      if (typeof d.content === 'string' && d.encoding === 'base64') {
        text = Buffer.from(d.content, 'base64').toString('utf8');
      } else {
        // Files over 1 MB come back without inline content; ask for the raw bytes.
        const raw = await rest.request('GET /repos/{owner}/{repo}/contents/{path}', {
          ...params,
          headers: { accept: 'application/vnd.github.raw+json' },
        });
        text = String(raw.data);
      }
      contentCache.set(key, text);
      return text;
    },

    async fetchReviewThreads(ref) {
      const threads: ReviewThread[] = [];
      let after: string | null = null;
      for (;;) {
        const res = (await gql(THREADS_QUERY, {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          after,
        })) as Json;
        const conn = res.repository?.pullRequest?.reviewThreads;
        if (!conn) break;
        for (const t of conn.nodes as Json[]) {
          const comments: ThreadComment[] = (t.comments?.nodes ?? []).map(toThreadComment);
          // Threads with more than 100 comments need their own pagination.
          let page = t.comments?.pageInfo;
          while (page?.hasNextPage) {
            const more = (await gql(THREAD_COMMENTS_QUERY, {
              id: t.id,
              after: page.endCursor,
            })) as Json;
            const next = more.node?.comments;
            if (!next) break;
            comments.push(...(next.nodes as Json[]).map(toThreadComment));
            page = next.pageInfo;
          }
          threads.push({
            id: t.id,
            isResolved: !!t.isResolved,
            isOutdated: !!t.isOutdated,
            path: t.path,
            line: t.line ?? null,
            originalLine: t.originalLine ?? null,
            diffSide: t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
            startLine: t.startLine ?? null,
            comments,
          });
        }
        if (!conn.pageInfo?.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      return threads;
    },

    async fetchCommits(ref) {
      const raw = await paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
      });
      return raw.map((c): PrCommit => ({
        sha: c.sha,
        message: c.commit?.message ?? '',
        author: c.author?.login ?? c.commit?.author?.name ?? null,
        date: c.commit?.author?.date ?? null,
      }));
    },

    async compareCommits(ref, base, head) {
      try {
        const commits: PrCommit[] = [];
        let files: string[] = [];
        let total = 0;
        for (let page = 1; ; page++) {
          const { data } = await rest.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner: ref.owner,
            repo: ref.repo,
            basehead: `${base}...${head}`,
            per_page: PER_PAGE,
            page,
          });
          const d = data as Json;
          const pageCommits = (d.commits ?? []) as Json[];
          if (page === 1) {
            // Files are only returned (in full) on the first page.
            files = ((d.files ?? []) as Json[]).map((f) => f.filename as string);
            total = typeof d.total_commits === 'number' ? d.total_commits : pageCommits.length;
          }
          for (const c of pageCommits) {
            commits.push({
              sha: c.sha,
              message: c.commit?.message ?? '',
              author: c.author?.login ?? c.commit?.author?.name ?? null,
              date: c.commit?.author?.date ?? null,
            });
          }
          if (
            pageCommits.length < PER_PAGE ||
            commits.length >= total ||
            commits.length >= MAX_COMPARE_COMMITS
          ) {
            break;
          }
        }
        const capped = commits.slice(0, MAX_COMPARE_COMMITS);
        return {
          commits: capped,
          files,
          totalCommits: Math.max(total, capped.length),
          ...(total > capped.length ? { commitsTruncated: true } : {}),
          ...(files.length >= COMPARE_FILE_LIMIT ? { filesTruncated: true } : {}),
        };
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        if (status === 404 || status === 422) return undefined;
        throw err;
      }
    },

    getViewerLogin() {
      viewer ??= rest.request('GET /user').then(({ data }) => (data as Json).login as string);
      viewer.catch(() => (viewer = undefined));
      return viewer;
    },

    async submitReview(ref, input) {
      const { data } = await rest.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        {
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          commit_id: input.headSha,
          event: input.event,
          body: input.body,
          comments: input.comments,
        },
      );
      const d = data as Json;
      return { id: d.id, url: d.html_url };
    },

    async replyToComment(ref, commentId, body) {
      const { data } = await rest.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
        { owner: ref.owner, repo: ref.repo, pull_number: ref.number, comment_id: commentId, body },
      );
      const d = data as Json;
      return { id: d.id, url: d.html_url };
    },
  };
}
