const TOKEN_HEADER = 'x-review-dash-token';

/** Session token, kept in memory only. */
let token = '';

/** Reads `#token=...` from the URL, then strips it from the address bar. */
export function initToken(): void {
  const params = new URLSearchParams(location.hash.slice(1));
  token = params.get('token') ?? '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, token);
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}
