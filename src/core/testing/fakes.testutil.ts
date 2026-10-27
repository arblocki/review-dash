import { readFileSync } from 'node:fs';
import type { RawFile } from '../diff/types.js';
import type { GitHubClient, PrMeta, ReviewThread, SubmitReviewInput } from '../github/types.js';

export interface Fixture {
  pr: PrMeta;
  files: RawFile[];
  viewer: string;
}

export function loadFixture(): Fixture {
  const url = new URL('../../../test/fixtures/pr-payload.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Fixture;
}

export interface FakeGitHub extends GitHubClient {
  calls: {
    submitReview: SubmitReviewInput[];
    replies: { id: number; body: string }[];
    fetchPr: number;
  };
  setHead(sha: string): void;
  /** Edits PR metadata (title/body/...) without moving the head. */
  setMeta(patch: Partial<PrMeta>): void;
  threads: ReviewThread[];
}

/** In-memory GitHubClient backed by the fixture. */
export function fakeGitHub(overrides: Partial<Fixture> = {}): FakeGitHub {
  const fx = { ...loadFixture(), ...overrides };
  const pr = { ...fx.pr };
  const fake: FakeGitHub = {
    calls: { submitReview: [], replies: [], fetchPr: 0 },
    threads: [],
    setHead(sha) {
      pr.headSha = sha;
    },
    setMeta(patch) {
      Object.assign(pr, patch);
    },
    async fetchPr() {
      fake.calls.fetchPr++;
      return { ...pr };
    },
    async fetchFiles() {
      return fx.files;
    },
    async fetchFileContent(_ref, path, sha) {
      return `content of ${path}@${sha}`;
    },
    async fetchReviewThreads() {
      return fake.threads;
    },
    async fetchCommits() {
      return [];
    },
    async getViewerLogin() {
      return fx.viewer;
    },
    async submitReview(_ref, input) {
      fake.calls.submitReview.push(input);
      return { id: 42, url: 'https://github.com/octocat/hello-world/pull/1#pullrequestreview-42' };
    },
    async replyToComment(_ref, id, body) {
      fake.calls.replies.push({ id, body });
      return { id: 99, url: 'https://github.com/octocat/hello-world/pull/1#discussion_r99' };
    },
  };
  return fake;
}
