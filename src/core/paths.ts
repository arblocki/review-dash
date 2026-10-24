import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/** Data directory (database, caches): $REVIEW_DASH_HOME or ~/.review-dash. */
export function dataDir(env: Env = process.env, home: string = homedir()): string {
  return env.REVIEW_DASH_HOME || join(home, '.review-dash');
}

/** Config directory: $XDG_CONFIG_HOME/review-dash or ~/.config/review-dash. */
export function configDir(env: Env = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'review-dash');
}

export function dbPath(env: Env = process.env, home: string = homedir()): string {
  return join(dataDir(env, home), 'review-dash.db');
}
