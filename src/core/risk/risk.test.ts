import { describe, expect, it } from 'vitest';
import { classifyFiles } from '../classify/index.js';
import { mkFile } from '../group/files.testutil.js';
import type { DraftGroup } from '../group/types.js';
import { applyRisk } from './apply.js';
import { matchGlob } from './glob.js';
import { assessRisk, MAX_PATTERN_INPUT_CHARS, type RiskRule } from './rules.js';

const classify = (...f: Parameters<typeof mkFile>[]) => classifyFiles(f.map((x) => mkFile(...x)));

const draft = (hunkIds: string[], over: Partial<DraftGroup> = {}): DraftGroup => ({
  title: 't',
  intent: '',
  kind: 'feature',
  risk: 'low',
  riskReasons: [],
  verify: [],
  hunkIds,
  dependsOnIdx: [],
  llmIndex: 0,
  ...over,
});

describe('glob', () => {
  it('matches basename globs anywhere and path globs', () => {
    expect(matchGlob('*.tf', 'infra/main.tf')).toBe(true);
    expect(matchGlob('.github/workflows/**', '.github/workflows/ci.yml')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'lib/c.ts')).toBe(false);
    expect(matchGlob('*.{js,ts}', 'x/a.ts')).toBe(true);
    expect(matchGlob('Dockerfile*', 'svc/Dockerfile.dev')).toBe(true);
  });
});

describe('built-in rules', () => {
  const risk = (path: string, rows: string[] = ['+x']) => assessRisk(classify([path, rows]));

  it.each([
    ['src/auth/login.ts', 'high'],
    ['src/lib/crypto.ts', 'high'],
    ['.github/workflows/ci.yml', 'high'],
    ['db/migrations/001.sql', 'high'],
    ['package.json', 'medium'],
    ['infra/main.tf', 'medium'],
    ['Dockerfile', 'medium'],
    ['k8s/deploy.yaml', 'medium'],
    ['src/plain.ts', 'low'],
    ['src/auth/login.test.ts', 'low'],
  ] as const)('%s -> %s', (path, expected) => {
    expect(risk(path).risk).toBe(expected);
  });

  it('flags exported API changes in non-test files only', () => {
    expect(risk('src/util.ts', ['-export function a() {}', '+export function a(x) {}']).risk).toBe(
      'medium',
    );
    expect(risk('src/util.ts', ['+const a = 1;']).risk).toBe('low');
    expect(risk('src/util.test.ts', ['+export const t = 1;']).risk).toBe('low');
  });

  it('flags large deletions', () => {
    const rows = Array.from({ length: 101 }, (_, i) => `-line ${i}`);
    const a = risk('src/big.ts', rows);
    expect(a.risk).toBe('medium');
    expect(a.reasons).toEqual(['Deletes 101 lines']);
    expect(risk('src/big.ts', rows.slice(0, 100)).risk).toBe('low');
  });

  it('supports custom rules with glob + pattern', () => {
    const rule: RiskRule = {
      glob: 'src/pay/**',
      pattern: /charge\(/,
      risk: 'high',
      reason: 'money',
    };
    const hit = classify(['src/pay/a.ts', ['+charge(1)']]);
    const miss = classify(['src/pay/a.ts', ['+other()']]);
    expect(assessRisk(hit, [rule])).toEqual({ risk: 'high', reasons: ['money'] });
    expect(assessRisk(miss, [rule]).risk).toBe('low');
  });
});

describe('applyRisk', () => {
  it('takes the max of model and rules and appends rule reasons', () => {
    const hunks = classify(['src/auth/a.ts', ['+x']]);
    const map = new Map(hunks.map((h) => [h.hunk.id, h]));
    const low = applyRisk(draft([hunks[0]!.hunk.id], { risk: 'low', riskReasons: ['model'] }), map);
    expect(low.risk).toBe('high');
    expect(low.riskReasons[0]).toBe('model');
    expect(low.riskReasons).toHaveLength(2);
    const hi = applyRisk(
      draft([hunks[0]!.hunk.id], { risk: 'high' }),
      new Map([[hunks[0]!.hunk.id, classify(['src/x.ts', ['+y']])[0]!]]),
    );
    expect(hi.risk).toBe('high');
  });

  it('auto-clears only strictly clearable low-risk groups', () => {
    const hunks = classify(
      ['README.md', ['+hi']],
      ['src/a.ts', ['+// note']],
      ['src/b.ts', ['+code()']],
      ['docs/auth/x.md', ['+auth docs']],
    );
    const map = new Map(hunks.map((h) => [h.hunk.id, h]));
    const ids = hunks.map((h) => h.hunk.id);
    expect(applyRisk(draft([ids[0]!, ids[1]!]), map).autoClear).toBe(false); // comment-only
    expect(applyRisk(draft([ids[0]!]), map).autoClear).toBe(true);
    expect(applyRisk(draft([ids[0]!, ids[2]!]), map).autoClear).toBe(false);
    expect(applyRisk(draft([ids[0]!], { risk: 'medium' }), map).autoClear).toBe(false);
    expect(applyRisk(draft([ids[3]!]), map).autoClear).toBe(true);
    expect(applyRisk(draft([ids[0]!], { unclassified: true }), map)).toMatchObject({
      autoClear: false,
      risk: 'medium',
    });
  });
});

describe('pattern input cap', () => {
  it('only tests the first 1,000 characters of a line', () => {
    const rule: RiskRule = { risk: 'high', reason: 'needle', pattern: /needle/ };
    const early = classify(['a.ts', [`+needle${'x'.repeat(2000)}`]]);
    const late = classify(['a.ts', [`+${'x'.repeat(MAX_PATTERN_INPUT_CHARS)}needle`]]);
    expect(assessRisk(early, [rule]).risk).toBe('high');
    expect(assessRisk(late, [rule]).risk).toBe('low');
  });
});
