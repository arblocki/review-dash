import type { ClassifiedHunk } from './index.js';

/** Manifests that justify a lockfile change (keys are lowercase lockfile basenames). */
const NODE_MANIFEST = ['package.json'];
const MANIFESTS: Readonly<Record<string, readonly string[]>> = {
  'package-lock.json': NODE_MANIFEST,
  'npm-shrinkwrap.json': NODE_MANIFEST,
  'pnpm-lock.yaml': NODE_MANIFEST,
  'yarn.lock': NODE_MANIFEST,
  'bun.lock': NODE_MANIFEST,
  'bun.lockb': NODE_MANIFEST,
  'cargo.lock': ['cargo.toml'],
  'poetry.lock': ['pyproject.toml'],
  'uv.lock': ['pyproject.toml'],
  'pipfile.lock': ['pipfile'],
  'gemfile.lock': ['gemfile'],
  'composer.lock': ['composer.json'],
  'go.sum': ['go.mod'],
  'packages.lock.json': ['.csproj', '.fsproj', '.vbproj'],
  'mix.lock': ['mix.exs'],
  'pubspec.lock': ['pubspec.yaml'],
  'podfile.lock': ['podfile'],
};

const INTEGRITY_LINE =
  /integrity|checksum|sha(1|256|512)-|"resolved"|resolved:|tarball|\bsource\s*=|registry/i;
const VERSION_LINE = /version/i;

export const LOCKFILE_NO_MANIFEST_REASON = 'Lockfile changed without a matching manifest change';
export const LOCKFILE_INTEGRITY_REASON =
  'Integrity hash or resolved source changed without a version change';

export interface LockfileAssessment {
  /** Lockfile hunks that must not be auto-cleared, with why. */
  flagged: Map<string, { noManifest?: string; integrity?: boolean }>;
}

function split(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return {
    dir: i < 0 ? '' : path.slice(0, i),
    base: (i < 0 ? path : path.slice(i + 1)).toLowerCase(),
  };
}

/** The changed manifest that covers this lockfile, or undefined. Root lockfiles cover the whole workspace. */
function findManifest(lockPath: string, allPaths: readonly string[]): string | undefined {
  const { dir, base } = split(lockPath);
  const wanted = MANIFESTS[base] ?? [];
  return allPaths.find((p) => {
    const m = split(p);
    if (dir !== '' && m.dir !== dir) return false;
    return wanted.some((w) => (w.startsWith('.') ? m.base.endsWith(w) : m.base === w));
  });
}

/**
 * Decides which lockfile hunks stay mechanical. A lockfile hunk is flagged when no associated
 * manifest changed in the PR, or when it changes integrity/checksum/resolved-source lines with
 * no version change in the same hunk. Unknown lockfile names (`*.lock`) need no manifest.
 */
export function assessLockfileHunks(
  classified: readonly ClassifiedHunk[],
  allPaths: readonly string[],
): LockfileAssessment {
  const flagged: LockfileAssessment['flagged'] = new Map();
  for (const c of classified) {
    if (!c.tags.includes('lockfile')) continue;
    const entry: { noManifest?: string; integrity?: boolean } = {};
    const { base } = split(c.hunk.path);
    if (MANIFESTS[base] && !findManifest(c.hunk.path, allPaths)) {
      const { dir } = split(c.hunk.path);
      entry.noManifest = `${dir ? `${dir}/` : ''}${MANIFESTS[base]![0]!.replace(/^\./, '*.')}`;
    }
    const changed = c.hunk.lines.filter((l) => l.type !== 'context').map((l) => l.content);
    if (changed.some((l) => INTEGRITY_LINE.test(l)) && !changed.some((l) => VERSION_LINE.test(l))) {
      entry.integrity = true;
    }
    if (entry.noManifest || entry.integrity) flagged.set(c.hunk.id, entry);
  }
  return { flagged };
}
