export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

const NAME = '[A-Za-z0-9_.-]+';
const SHORT = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);
const URL_PATH = new RegExp(`^/(${NAME})/(${NAME})/pull/(\\d+)(?:/.*)?$`);

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

function matchUrl(text: string): RegExpExecArray | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  return URL_PATH.exec(url.pathname);
}

export function formatPrRef({ owner, repo, number }: PrRef): string {
  return `${owner}/${repo}#${number}`;
}
