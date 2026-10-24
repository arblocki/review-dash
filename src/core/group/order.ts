import { createHash } from 'node:crypto';
import type { Hunk } from '../diff/types.js';
import type { DraftGroup } from './types.js';

export type OrderedGroup = DraftGroup & { key: string; dependsOn: string[] };

export function groupKey(hunkIds: readonly string[]): string {
  return createHash('sha1')
    .update([...hunkIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

function tier(g: DraftGroup): number {
  if (g.mechanical) return 3;
  return g.risk === 'high' ? 0 : g.risk === 'medium' ? 1 : 2;
}

/**
 * Orders groups: risk high -> medium -> low -> mechanical (unclassified sorts with its risk,
 * ahead of same-risk peers), then topologically by depends_on inside each risk tier so a
 * dependency is read before its users. Cycles are ignored. Hunks within a group are sorted
 * by path, then new-file line. `depends_on` indices (LLM order) become stable group keys.
 */
export function orderGroups(
  groups: readonly DraftGroup[],
  hunkById: ReadonlyMap<string, { hunk: Hunk }>,
): OrderedGroup[] {
  const withKeys = groups.map((g) => {
    const hunkIds = [...g.hunkIds].sort((a, b) => {
      const ha = hunkById.get(a)?.hunk;
      const hb = hunkById.get(b)?.hunk;
      if (!ha || !hb) return 0;
      return ha.path < hb.path ? -1 : ha.path > hb.path ? 1 : ha.newStart - hb.newStart;
    });
    return { ...g, hunkIds, key: groupKey(hunkIds) };
  });

  const keyByLlmIndex = new Map<number, string>();
  for (const g of withKeys) if (g.llmIndex >= 0) keyByLlmIndex.set(g.llmIndex, g.key);

  const resolved: OrderedGroup[] = withKeys.map((g) => {
    const deps: string[] = [];
    for (const idx of g.dependsOnIdx) {
      const k = keyByLlmIndex.get(idx);
      if (k && k !== g.key && !deps.includes(k)) deps.push(k);
    }
    return { ...g, dependsOn: deps };
  });

  const base = resolved
    .map((g, i) => ({ g, i }))
    .sort(
      (a, b) =>
        tier(a.g) - tier(b.g) ||
        Number(!!b.g.unclassified) - Number(!!a.g.unclassified) ||
        a.i - b.i,
    )
    .map((x) => x.g);

  const out: OrderedGroup[] = [];
  for (let t = 0; t <= 3; t++) {
    const remaining = base.filter((g) => tier(g) === t);
    const tierKeys = new Set(remaining.map((g) => g.key));
    const placed = new Set<string>();
    while (remaining.length > 0) {
      let at = remaining.findIndex((g) =>
        g.dependsOn.every((d) => !tierKeys.has(d) || placed.has(d)),
      );
      if (at < 0) at = 0; // cycle: take the best-ranked remaining group
      const [next] = remaining.splice(at, 1);
      placed.add(next!.key);
      out.push(next!);
    }
  }
  return out;
}
