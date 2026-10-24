import { isTestPath } from './paths.js';

function split(path: string): { dir: string; base: string; stem: string } {
  const i = path.lastIndexOf('/');
  const dir = i < 0 ? '' : path.slice(0, i);
  const base = i < 0 ? path : path.slice(i + 1);
  const dot = base.indexOf('.');
  return { dir, base, stem: dot <= 0 ? base : base.slice(0, dot) };
}

/** Implementation stem a test file refers to, or undefined if it isn't recognisably named. */
function implStem(testPath: string): string | undefined {
  const { stem } = split(testPath);
  if (/^test_/.test(stem)) return stem.slice(5);
  if (/_(test|spec)$/.test(stem)) return stem.replace(/_(test|spec)$/, '');
  if (/(Test|Tests)$/.test(stem)) return stem.replace(/(Tests?)$/, '');
  // foo.test.ts / foo.spec.ts: the stem is already "foo"; __tests__/foo.ts likewise.
  return stem || undefined;
}

const TEST_DIR = /(^|\/)(__tests__|__test__|tests?)$/;

/**
 * Pairs each test file in `paths` with the implementation file it most likely covers:
 * foo.ts <-> foo.test.ts / foo.spec.ts / __tests__/foo.ts, x.py <-> test_x.py / x_test.py,
 * x.go <-> x_test.go. Only paths in `paths` are considered. Returns testPath -> implPath.
 */
export function pairTests(paths: readonly string[]): Map<string, string> {
  const impls = paths.filter((p) => !isTestPath(p));
  const byStem = new Map<string, string[]>();
  for (const p of impls) {
    const s = split(p).stem;
    byStem.set(s, [...(byStem.get(s) ?? []), p]);
  }
  const pairs = new Map<string, string>();
  for (const t of paths) {
    if (!isTestPath(t)) continue;
    const stem = implStem(t);
    const candidates = stem ? byStem.get(stem) : undefined;
    if (!candidates?.length) continue;
    const tdir = split(t).dir;
    const parent = tdir.includes('/') ? tdir.slice(0, tdir.lastIndexOf('/')) : '';
    const sameDir = candidates.find((c) => split(c).dir === tdir);
    const parentDir = TEST_DIR.test(tdir)
      ? candidates.find((c) => split(c).dir === parent || split(c).dir.startsWith(`${parent}/`))
      : undefined;
    const pick = sameDir ?? parentDir ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (pick) pairs.set(t, pick);
  }
  return pairs;
}
