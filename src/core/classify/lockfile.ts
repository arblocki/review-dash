import type { DiffLine } from '../diff/types.js';
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

const JSON_VERSION = /^\s*"version"\s*:/;
const YARN_VERSION = /^\s*version(\s+"|:)/;
const TOML_VERSION = /^\s*version\s*=\s*"/;
const GEM_SPEC = /^\s+[\w.-]+ \(\d[^)]*\)\s*$/;
const GO_SUM_LINE = /^(\S+) (\S+?)(?:\/go\.mod)? h1:/;

/** Per-format matchers for real version fields. Formats not listed here have none. */
const VERSION_FIELD: Readonly<Record<string, RegExp>> = {
  'package-lock.json': JSON_VERSION,
  'npm-shrinkwrap.json': JSON_VERSION,
  'composer.lock': JSON_VERSION,
  'pipfile.lock': JSON_VERSION,
  'yarn.lock': YARN_VERSION,
  'pnpm-lock.yaml': /^\s*version:/,
  'cargo.lock': TOML_VERSION,
  'poetry.lock': TOML_VERSION,
  'uv.lock': TOML_VERSION,
  'gemfile.lock': GEM_SPEC,
};

/** go.sum: a module whose version token differs between a removed and an added line. */
function goSumVersionChange(lines: readonly DiffLine[]): boolean {
  const versions = { del: new Map<string, Set<string>>(), add: new Map<string, Set<string>>() };
  for (const l of lines) {
    if (l.type === 'context') continue;
    const m = GO_SUM_LINE.exec(l.content);
    if (!m) continue;
    const set = versions[l.type].get(m[1]!) ?? new Set<string>();
    set.add(m[2]!);
    versions[l.type].set(m[1]!, set);
  }
  for (const [mod, removed] of versions.del) {
    const added = versions.add.get(mod);
    if (!added) continue;
    if ([...added].some((v) => !removed.has(v)) && [...removed].some((v) => !added.has(v))) {
      return true;
    }
  }
  return false;
}

function hasVersionChange(base: string, lines: readonly DiffLine[]): boolean {
  if (base === 'go.sum') return goSumVersionChange(lines);
  const re = VERSION_FIELD[base];
  return !!re && lines.some((l) => l.type !== 'context' && re.test(l.content));
}

/** go.sum has no keyword to key on: any hash line is integrity data. */
function isIntegrityLine(base: string, content: string): boolean {
  return INTEGRITY_LINE.test(content) || (base === 'go.sum' && GO_SUM_LINE.test(content));
}

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
 * no real version-field change in the same hunk (matched per format, anchored at line start; unknown
 * formats have no version lines, so integrity/source edits there are always flagged). Unknown
 * lockfile names (`*.lock`) need no manifest.
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
    if (changed.some((l) => isIntegrityLine(base, l)) && !hasVersionChange(base, c.hunk.lines)) {
      entry.integrity = true;
    }
    if (entry.noManifest || entry.integrity) flagged.set(c.hunk.id, entry);
  }
  return { flagged };
}
