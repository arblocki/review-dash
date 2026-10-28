export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PrRef extends RepoRef {
  number: number;
}

const NAME = '[A-Za-z0-9_.-]+';
const SHORT = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);
const URL_PATH = new RegExp(`^/(${NAME})/(${NAME})/pull/(\\d+)(?:/.*)?$`);
const REPO_SHORT = new RegExp(`^(${NAME})/(${NAME})$`);
const REPO_URL_PATH = new RegExp(`^/(${NAME})/(${NAME})(?:/pulls)?/?$`);

/** Parses `owner/repo#123` or a github.com pull request URL. Returns null if invalid. */
export function parsePrRef(input: string): PrRef | null {
  const text = input.trim();
  const match = SHORT.exec(text) ?? matchUrl(text);
  if (!match) return null;
  const [, owner, repo, num] = match;
  const number = Number(num);
  if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) return null;
  return { owner, repo, number };
}

/** Parses `owner/repo` or a github.com repository URL. Returns null if invalid. */
export function parseRepoRef(input: string): RepoRef | null {
  const text = input.trim();
  const match = REPO_SHORT.exec(text) ?? matchUrl(text, REPO_URL_PATH);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/, '');
  if (!owner || !repo || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

function matchUrl(text: string, path = URL_PATH): RegExpExecArray | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  return path.exec(url.pathname);
}

export function formatPrRef({ owner, repo, number }: PrRef): string {
  return `${owner}/${repo}#${number}`;
}

export function formatRepoRef({ owner, repo }: RepoRef): string {
  return `${owner}/${repo}`;
}
