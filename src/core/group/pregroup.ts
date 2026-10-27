import { pairTests, type ClassifiedHunk } from '../classify/index.js';
import { UnionFind } from './union-find.js';

export interface Cluster {
  /** "c1", "c2", ... in order of first appearance. */
  id: string;
  paths: string[];
  hunkIds: string[];
}

/**
 * v1 deterministic candidate clusters over the non-mechanical hunks:
 * one cluster per file, with each test file unioned into the file it covers.
 */
export function preGroup(hunks: readonly ClassifiedHunk[]): Cluster[] {
  const byPath = new Map<string, string[]>();
  for (const { hunk, mechanical } of hunks) {
    if (mechanical) continue;
    byPath.set(hunk.path, [...(byPath.get(hunk.path) ?? []), hunk.id]);
  }
  const paths = [...byPath.keys()];
  const uf = new UnionFind();
  for (const p of paths) uf.add(p);
  for (const [test, impl] of pairTests(paths)) uf.union(impl, test);

  return uf.groups().map((members, i) => ({
    id: `c${i + 1}`,
    paths: members,
    hunkIds: members.flatMap((p) => byPath.get(p) ?? []),
  }));
}
