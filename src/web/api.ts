const TOKEN_HEADER = 'x-review-dash-token';

const STORAGE_KEY = 'review-dash-token';

/** Session token; persisted in sessionStorage so a reload keeps it. */
let token = '';

type TokenStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A token in the hash wins and is stored; otherwise fall back to storage. Never throws. */
export function resolveToken(hash: string, storage: TokenStorage | undefined): string {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  try {
    if (fromHash) {
      storage?.setItem(STORAGE_KEY, fromHash);
      return fromHash;
    }
    return storage?.getItem(STORAGE_KEY) ?? '';
  } catch {
    return fromHash;
  }
}

/** Resolves the token from `#token=...` or sessionStorage, then strips the hash. */
export function initToken(): void {
  let storage: TokenStorage | undefined;
  try {
    storage = sessionStorage;
  } catch {
    storage = undefined;
  }
  token = resolveToken(location.hash, storage);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

/** Non-2xx response; `body` is the parsed JSON error payload when there was one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    return typeof this.body.code === 'string' ? this.body.code : undefined;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, token);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    const message = typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }
  return (await res.json()) as T;
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}
