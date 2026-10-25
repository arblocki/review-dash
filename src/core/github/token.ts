import { execFile } from 'node:child_process';

export type CommandRunner = (cmd: string, args: string[]) => Promise<string>;

const run: CommandRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

/**
 * Resolves a GitHub token: `gh auth token` first (failures ignored), then GITHUB_TOKEN.
 * The token is only held in memory; callers must never log or return it.
 */
export async function resolveToken(
  env: Record<string, string | undefined> = process.env,
  runner: CommandRunner = run,
): Promise<string> {
  try {
    const out = (await runner('gh', ['auth', 'token'])).trim();
    if (out) return out;
  } catch {
    // gh missing or not logged in: fall through to the env var.
  }
  const fromEnv = env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    'No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN (see .env.example).',
  );
}
