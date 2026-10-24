import { diffHash, parseFile } from './diff/parse.js';
import type { ParsedFile } from './diff/types.js';
import type { GitHubClient, PrMeta } from './github/types.js';
import type { PrRef } from './pr-ref.js';

export interface PrData {
  pr: PrMeta;
  files: ParsedFile[];
  diffHash: string;
  viewer: string;
  isSelfReview: boolean;
}

export async function loadPrData(github: GitHubClient, ref: PrRef): Promise<PrData> {
  const [pr, raw, viewer] = await Promise.all([
    github.fetchPr(ref),
    github.fetchFiles(ref),
    github.getViewerLogin(),
  ]);
  const files = raw.map(parseFile);
  return {
    pr,
    files,
    diffHash: diffHash(files),
    viewer,
    isSelfReview: viewer.toLowerCase() === pr.author.toLowerCase(),
  };
}
