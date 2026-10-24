import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzePr, type Analysis } from '../src/core/group/index.js';
import { parseFile } from '../src/core/diff/parse.js';
import type { RawFile } from '../src/core/diff/types.js';
import { createProvider, FakeProvider, loadConfig } from '../src/core/llm/index.js';

interface EvalFixture {
  name?: string;
  pr: { title: string; body: string };
  files: RawFile[];
  reviewMd?: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fake = args.includes('--fake');
const only = flag('--fixture');

const dir = new URL('../test/fixtures/eval/', import.meta.url).pathname;
const names = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => !only || f.startsWith(only));

const config = loadConfig();
// --fake: every reply is unparseable, so analysis takes the deterministic fallback path.
const provider = fake
  ? new FakeProvider(
      Array.from({ length: names.length * 2 }, () => 'not json'),
      'fake',
    )
  : createProvider(config, { provider: flag('--provider'), model: flag('--model') });
const model = fake
  ? 'fake'
  : (flag('--model') ?? config.models[provider.id as keyof typeof config.models]);

const fmt = (n: number | undefined, d = 0) => (n === undefined ? '-' : n.toFixed(d));

for (const file of names) {
  const fx = JSON.parse(readFileSync(join(dir, file), 'utf8')) as EvalFixture;
  const files = fx.files.map(parseFile);
  const hunks = files.reduce((n, f) => n + f.hunks.length, 0);
  const started = Date.now();
  let a: Analysis;
  try {
    a = await analyzePr({
      pr: fx.pr,
      files,
      provider,
      model,
      reviewMd: fx.reviewMd,
      config: { maxConcurrency: config.maxConcurrency },
    });
  } catch (err) {
    console.log(`\n== ${fx.name ?? file}: FAILED (${(err as Error).message})`);
    continue;
  }
  console.log(`\n== ${fx.name ?? file}  [${a.provider} / ${a.model}]`);
  console.log(`files: ${files.length}  hunks: ${hunks}  groups: ${a.groups.length}`);
  console.log(`fallback: ${a.fallback}  map-reduce: ${a.mapReduce}  back-filled: ${a.backfilled}`);
  for (const g of a.groups) {
    const flags = [g.autoClear ? 'auto-clear' : '', g.unclassified ? 'unclassified' : '']
      .filter(Boolean)
      .join(',');
    console.log(
      `  ${g.risk.toUpperCase().padEnd(6)} ${String(g.hunkIds.length).padStart(3)} hunks  ${g.title}${flags ? ` (${flags})` : ''}`,
    );
  }
  const u = a.usage;
  console.log(
    `tokens in/out: ${fmt(u?.inputTokens)}/${fmt(u?.outputTokens)}  cost: $${fmt(u?.costUsd, 4)}  time: ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
