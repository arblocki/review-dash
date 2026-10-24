import { describe, expect, it } from 'vitest';
import { classifyFiles, type ClassifiedHunk } from '../classify/index.js';
import type { ParsedFile } from '../diff/types.js';
import { FakeProvider } from '../llm/fake.js';
import { LlmError } from '../llm/types.js';
import { analyzePr } from './analyze.js';
import { mkFile } from './files.testutil.js';
import { orderGroups } from './order.js';
import { preGroup } from './pregroup.js';
import { buildGroupingPrompt, groupingOutputSchema, type GroupingOutput } from './prompt.js';
import { MECHANICAL_TITLE, UNCLASSIFIED_TITLE, type Analysis, type DraftGroup } from './types.js';
import { UnionFind } from './union-find.js';
import { validateGrouping } from './validate.js';

const FILES: ParsedFile[] = [
  mkFile('src/send.ts', [['-a', '+b'], ['+c']]),
  mkFile('src/send.test.ts', ['+test()']),
  mkFile('src/util.ts', ['+u']),
  mkFile('docs/guide.md', ['+hello']),
  mkFile('package-lock.json', ['+lock']),
  mkFile('src/gen.ts', ['-  a  b', '+a b']),
  mkFile('README.md', ['+x']),
];

const classified = () => classifyFiles(FILES);
const reviewableIds = (c: ClassifiedHunk[]) => c.filter((h) => !h.mechanical).map((h) => h.hunk.id);

function out(groups: Partial<GroupingOutput['groups'][number]>[]): GroupingOutput {
  return {
    summary: 'sum',
    unrelated_or_suspicious: [],
    groups: groups.map((g) => ({
      title: 'G',
      intent: 'i',
      kind: 'feature',
      risk: 'low',
      risk_reasons: [],
      verify: [],
      hunk_ids: [],
      depends_on: [],
      ...g,
    })),
  };
}

function assertInvariant(groups: { hunkIds: string[] }[], all: ClassifiedHunk[]) {
  const seen = groups.flatMap((g) => g.hunkIds);
  expect(new Set(seen).size).toBe(seen.length);
  expect(new Set(seen)).toEqual(new Set(all.map((h) => h.hunk.id)));
}

describe('UnionFind / preGroup', () => {
  it('unions', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('c', 'd');
    uf.union('b', 'c');
    uf.add('e');
    expect(uf.groups()).toEqual([['a', 'b', 'c', 'd'], ['e']]);
  });

  it('one cluster per file, tests joined to their implementation, mechanical excluded', () => {
    const clusters = preGroup(classified());
    const byPaths = clusters.map((c) => c.paths);
    expect(byPaths).toContainEqual(['src/send.ts', 'src/send.test.ts']);
    expect(byPaths.flat()).not.toContain('package-lock.json');
    expect(byPaths.flat()).not.toContain('src/gen.ts'); // whitespace-only
    const send = clusters.find((c) => c.paths.includes('src/send.ts'))!;
    expect(send.hunkIds).toHaveLength(3);
    expect(clusters.map((c) => c.id)).toEqual(clusters.map((_, i) => `c${i + 1}`));
  });
});

describe('prompt', () => {
  it('includes reviewable hunks and excludes mechanical ones', () => {
    const c = classified();
    const p = buildGroupingPrompt({
      pr: { title: 'My title', body: 'My body' },
      hunks: c,
      clusters: preGroup(c),
      reviewMd: 'Payments are scary',
    });
    for (const h of c) {
      expect(p.prompt.includes(h.hunk.id)).toBe(!h.mechanical);
    }
    expect(p.prompt).toContain('My title');
    expect(p.prompt).toContain('My body');
    expect(p.prompt).toContain('Payments are scary');
    expect(p.prompt).toContain('c1:');
    expect(p.prompt).not.toContain('+lock');
  });

  it('trims long hunks with a note', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `+line${i}`);
    const c = classifyFiles([mkFile('src/big.ts', rows)]);
    const p = buildGroupingPrompt({
      pr: { title: 't', body: '' },
      hunks: c,
      clusters: [],
      maxHunkLines: 10,
    });
    expect(p.prompt).toContain('+line9');
    expect(p.prompt).not.toContain('+line10\n');
    expect(p.prompt).toContain('40 more lines of this hunk trimmed');
  });

  it('schema accepts snake_case output and tolerates missing lists / bad enums', () => {
    const v = groupingOutputSchema.parse({
      summary: 's',
      groups: [{ title: 't', kind: 'weird', risk: 'huge', hunk_ids: ['a'] }],
    });
    expect(v.groups[0]).toMatchObject({ kind: 'other', risk: 'medium', depends_on: [] });
  });
});

describe('validateGrouping', () => {
  it('passes a perfect grouping through; mechanical goes to its own group', () => {
    const c = classified();
    const ids = reviewableIds(c);
    const r = validateGrouping(out([{ hunk_ids: ids }]), c);
    expect(r.backfilled).toBe(0);
    expect(r.groups.map((g) => g.title)).toEqual(['G', MECHANICAL_TITLE]);
    const mech = r.groups.at(-1)!;
    expect(mech).toMatchObject({ kind: 'mechanical', risk: 'low', autoClear: true });
    assertInvariant(r.groups, c);
  });

  it('drops unknown ids, dedupes keeping the first, back-fills the rest', () => {
    const c = classified();
    const ids = reviewableIds(c);
    const r = validateGrouping(
      out([
        { title: 'A', hunk_ids: [ids[0]!, 'nope', ids[1]!] },
        { title: 'B', hunk_ids: [ids[1]!, ids[0]!, ' ' + ids[2]! + ' '] },
        { title: 'Empty', hunk_ids: ['ghost'] },
      ]),
      c,
    );
    expect(r.unknownIds).toBe(2);
    expect(r.duplicateIds).toBe(2);
    expect(r.groups.map((g) => g.title)).toEqual(['A', 'B', UNCLASSIFIED_TITLE, MECHANICAL_TITLE]);
    expect(r.groups[0]!.hunkIds).toEqual([ids[0], ids[1]]);
    expect(r.groups[1]!.hunkIds).toEqual([ids[2]]);
    const un = r.groups[2]!;
    expect(un).toMatchObject({ unclassified: true, risk: 'medium' });
    expect(un.hunkIds).toEqual(ids.slice(3));
    expect(r.backfilled).toBe(ids.length - 3);
    assertInvariant(r.groups, c);
  });

  it('keeps mechanical hunks out of model groups even if the model lists them', () => {
    const c = classified();
    const all = c.map((h) => h.hunk.id);
    const r = validateGrouping(out([{ hunk_ids: all }]), c);
    expect(r.groups[0]!.hunkIds).toEqual(reviewableIds(c));
    assertInvariant(r.groups, c);
  });

  it('holds the invariant for pseudo-random model output', () => {
    const c = classified();
    const all = c.map((h) => h.hunk.id);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 200; n++) {
      const groups = Array.from({ length: Math.floor(rnd() * 5) }, () => ({
        hunk_ids: Array.from({ length: Math.floor(rnd() * 6) }, () =>
          rnd() < 0.2 ? 'bogus' + n : all[Math.floor(rnd() * all.length)]!,
        ),
      }));
      const r = validateGrouping(out(groups), c);
      assertInvariant(r.groups, c);
      for (const g of r.groups) expect(g.hunkIds.length).toBeGreaterThan(0);
    }
  });

  it('falls back to top-level directory groups when there is no model output', () => {
    const c = classified();
    const r = validateGrouping(undefined, c);
    expect(r.groups.map((g) => g.title).sort()).toEqual(
      ['Changes in (repo root)', 'Changes in docs/', 'Changes in src/', MECHANICAL_TITLE].sort(),
    );
    assertInvariant(r.groups, c);
  });
});

describe('orderGroups', () => {
  const hunkById = new Map(classified().map((c) => [c.hunk.id, c]));
  const [h0, h1, h2, h3, , h5] = reviewableIds(classified());
  const g = (title: string, ids: string[], over: Partial<DraftGroup> = {}): DraftGroup => ({
    title,
    intent: '',
    kind: 'feature',
    risk: 'low',
    riskReasons: [],
    verify: [],
    hunkIds: ids,
    dependsOnIdx: [],
    llmIndex: -1,
    ...over,
  });

  it('orders risk first, mechanical last, unclassified ahead of same-risk peers', () => {
    const r = orderGroups(
      [
        g('mech', [h5!], { mechanical: true }),
        g('low', [h0!], { llmIndex: 0 }),
        g('med', [h1!], { llmIndex: 1, risk: 'medium' }),
        g('unc', [h2!], { unclassified: true, risk: 'medium' }),
        g('high', [h3!], { llmIndex: 2, risk: 'high' }),
      ],
      hunkById,
    );
    expect(r.map((x) => x.title)).toEqual(['high', 'unc', 'med', 'low', 'mech']);
  });

  it('orders by depends_on inside a tier, remaps indices to keys, ignores cycles and bad refs', () => {
    const r = orderGroups(
      [
        g('uses', [h0!], { llmIndex: 0, dependsOnIdx: [1, 9, 0] }),
        g('defines', [h1!], { llmIndex: 1 }),
        g('other', [h2!], { llmIndex: 2 }),
      ],
      hunkById,
    );
    expect(r.map((x) => x.title)).toEqual(['defines', 'uses', 'other']);
    expect(r[1]!.dependsOn).toEqual([r[0]!.key]);

    const cyc = orderGroups(
      [
        g('a', [h0!], { llmIndex: 0, dependsOnIdx: [1] }),
        g('b', [h1!], { llmIndex: 1, dependsOnIdx: [0] }),
      ],
      hunkById,
    );
    expect(cyc).toHaveLength(2);
  });

  it('sorts hunks by path then line and gives stable keys', () => {
    const c = classifyFiles([mkFile('b.ts', ['+x']), mkFile('a.ts', [['+x'], ['+y']])]);
    const ids = c.map((x) => x.hunk.id);
    const map = new Map(c.map((x) => [x.hunk.id, x]));
    const a = orderGroups([g('t', ids)], map)[0]!;
    const b = orderGroups([g('other title', [...ids].reverse())], map)[0]!;
    expect(a.hunkIds.map((id) => map.get(id)!.hunk.path)).toEqual(['a.ts', 'a.ts', 'b.ts']);
    expect(a.hunkIds[0]).toBe(c[0]!.hunk.id === a.hunkIds[0] ? a.hunkIds[0] : c[1]!.hunk.id);
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{16}$/);
  });
});

function idsFromPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/^## hunk ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
}

describe('analyzePr', () => {
  const base = { pr: { title: 'T', body: 'B' }, files: FILES, model: 'm' };

  it('groups, applies risk, orders, and satisfies the invariant', async () => {
    const provider = new FakeProvider([
      (req) => {
        const ids = idsFromPrompt(req.prompt);
        return JSON.stringify(
          out([
            { title: 'Docs', kind: 'docs', risk: 'low', hunk_ids: ids.slice(4) },
            { title: 'Code', risk: 'low', hunk_ids: ids.slice(0, 4), depends_on: [0] },
          ]),
        );
      },
    ]);
    const a = await analyzePr({ ...base, provider });
    expect(a.fallback).toBe(false);
    expect(a.promptVersion).toBeTruthy();
    expect(a.groups.at(-1)).toMatchObject({ title: MECHANICAL_TITLE, autoClear: true });
    const all = classified().map((h) => h.hunk.id);
    assertInvariant(a.groups, classified());
    expect(new Set(a.groups.flatMap((g) => g.hunkIds))).toEqual(new Set(all));
    // Code hunks reference exported symbols? no; Docs group is docs-only -> auto-clear.
    expect(a.groups.find((g) => g.title === 'Docs')!.autoClear).toBe(true);
    expect(a.groups.find((g) => g.title === 'Code')!.autoClear).toBe(false);
    expect(provider.requests[0]!.jsonSchema).toBeTruthy();
  });

  it('tolerates duplicate, unknown and partial ids from the provider', async () => {
    const provider = new FakeProvider([
      (req) => {
        const ids = idsFromPrompt(req.prompt);
        return JSON.stringify(
          out([
            { title: 'A', hunk_ids: [ids[0], ids[0], 'zzz'] as string[] },
            { title: 'B', hunk_ids: [ids[0], ids[1]] as string[] },
          ]),
        );
      },
    ]);
    const a = await analyzePr({ ...base, provider });
    expect(a.backfilled).toBe(reviewableIds(classified()).length - 2);
    const un = a.groups.find((g) => g.unclassified)!;
    expect(un.title).toBe(UNCLASSIFIED_TITLE);
    expect(['medium', 'high']).toContain(un.risk);
    expect(un.autoClear).toBe(false);
    assertInvariant(a.groups, classified());
  });

  it('retries once on invalid JSON and then succeeds', async () => {
    const provider = new FakeProvider([
      'not json',
      (req) => JSON.stringify(out([{ hunk_ids: idsFromPrompt(req.prompt) }])),
    ]);
    const a = await analyzePr({ ...base, provider });
    expect(a.fallback).toBe(false);
    expect(provider.requests).toHaveLength(2);
  });

  it('falls back to directory grouping after bad output twice', async () => {
    const provider = new FakeProvider(['nope', '{"still":"wrong"}']);
    const a = await analyzePr({ ...base, provider });
    expect(a.fallback).toBe(true);
    expect(a.summary).toMatch(/grouped by directory/);
    expect(a.groups.map((g) => g.title)).toContain('Changes in src/');
    assertInvariant(a.groups, classified());
  });

  it('rethrows non-output provider errors', async () => {
    const provider = new FakeProvider([new LlmError('not_installed', 'claude not found')]);
    await expect(analyzePr({ ...base, provider })).rejects.toMatchObject({ kind: 'not_installed' });
  });

  it('does not call the model for mechanical-only PRs', async () => {
    const provider = new FakeProvider([]);
    const a = await analyzePr({
      ...base,
      files: [mkFile('package-lock.json', ['+x'])],
      provider,
    });
    expect(provider.requests).toHaveLength(0);
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0]!.title).toBe(MECHANICAL_TITLE);
    const empty = await analyzePr({ ...base, files: [], provider });
    expect(empty.groups).toEqual([]);
  });

  it('adds rule risk and reasons on top of the model rating', async () => {
    const files = [mkFile('src/auth/login.ts', ['+x'])];
    const provider = new FakeProvider([
      (req) =>
        JSON.stringify(
          out([{ risk: 'low', risk_reasons: ['model'], hunk_ids: idsFromPrompt(req.prompt) }]),
        ),
    ]);
    const a = await analyzePr({ ...base, files, provider });
    expect(a.groups[0]!.risk).toBe('high');
    expect(a.groups[0]!.riskReasons[0]).toBe('model');
    expect(a.groups[0]!.riskReasons.length).toBe(2);
  });

  it('uses map-reduce when over budget, with bounded concurrency and a map provider', async () => {
    let active = 0;
    let peak = 0;
    const mapProvider = new FakeProvider([]);
    mapProvider.complete = async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      mapProvider.requests.push(req);
      return { text: JSON.stringify({ summary: 'changes things', key_symbols: ['foo'] }) };
    };
    const provider = new FakeProvider([
      (req) => {
        expect(req.prompt).toContain('Summary: changes things');
        expect(req.prompt).not.toContain('```diff');
        return JSON.stringify(out([{ hunk_ids: idsFromPrompt(req.prompt).length ? [] : [] }]));
      },
    ]);
    // Reduce prompt lists hunks as "- <id> path"; collect ids from there.
    provider['queue'][0] = (req) => {
      const ids = [...req.prompt.matchAll(/^- ([0-9a-f]{40}) /gm)].map((m) => m[1]!);
      return JSON.stringify(out([{ hunk_ids: ids }]));
    };
    const a = await analyzePr({
      ...base,
      provider,
      mapProvider,
      config: { tokenBudget: 50, maxConcurrency: 2 },
    });
    expect(a.mapReduce).toBe(true);
    expect(mapProvider.requests.length).toBe(preGroup(classified()).length);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(1);
    assertInvariant(a.groups, classified());
    expect(a.backfilled).toBe(0);
  });

  it('keeps usage summed across calls', async () => {
    const provider = new FakeProvider([
      { text: 'bad', usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.5 } },
      {
        text: JSON.stringify(out([])),
        usage: { inputTokens: 20, outputTokens: 2, costUsd: 0.25 },
      },
    ]);
    const a: Analysis = await analyzePr({ ...base, provider });
    expect(a.usage).toEqual({ inputTokens: 30, outputTokens: 3, costUsd: 0.75 });
  });
});
