import { diffHash, parseFile } from './diff/parse.js';
import type { ParsedFile } from './diff/types.js';
import type { GitHubClient, PrMeta } from './github/types.js';
import type { PrRef } from './pr-ref.js';

/** Set when GitHub's file listing (capped at 3,000 files) does not cover the whole PR. */
export interface Incomplete {
  fetchedFiles: number;
  changedFiles: number;
  reason: string;
}

export interface PrData {
  pr: PrMeta;
  files: ParsedFile[];
  diffHash: string;
  viewer: string;
  isSelfReview: boolean;
  incomplete?: Incomplete;
}

export async function loadPrData(github: GitHubClient, ref: PrRef): Promise<PrData> {
  const [pr, raw, viewer] = await Promise.all([
    github.fetchPr(ref),
    github.fetchFiles(ref),
    github.getViewerLogin(),
  ]);
  const files = raw.map(parseFile);
  const data: PrData = {
    pr,
    files,
    diffHash: diffHash(files),
    viewer,
    isSelfReview: viewer.toLowerCase() === pr.author.toLowerCase(),
  };
  if (pr.changedFiles > raw.length) {
    data.incomplete = {
      fetchedFiles: raw.length,
      changedFiles: pr.changedFiles,
      reason: `GitHub lists at most 3,000 files per pull request; ${raw.length} of ${pr.changedFiles} changed files are shown.`,
    };
  }
  return data;
}
