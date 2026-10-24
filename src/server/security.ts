import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const TOKEN_HEADER = 'x-review-dash-token';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokensMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rejects requests whose Host/Origin is not this server (DNS rebinding / cross-site). */
export function hostGuard(getPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    const port = getPort();
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = c.req.header('host');
    if (!host || !allowedHosts.includes(host)) return c.json({ error: 'bad host' }, 403);
    const origin = c.req.header('origin');
    if (origin !== undefined && !allowedHosts.some((h) => origin === `http://${h}`)) {
      return c.json({ error: 'bad origin' }, 403);
    }
    await next();
  };
}

export function tokenGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!tokensMatch(token, c.req.header(TOKEN_HEADER))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
