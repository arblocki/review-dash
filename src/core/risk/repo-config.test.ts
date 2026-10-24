import { describe, expect, it } from 'vitest';
import { loadRepoConfig, parseRepoConfig } from './repo-config.js';
import { BUILTIN_RULES } from './rules.js';

const ref = { owner: 'o', repo: 'r', number: 1 };
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

function client(files: Record<string, string>) {
  return {
    async fetchFileContent(_r: unknown, path: string) {
      const t = files[path];
      if (t === undefined) throw notFound();
      return t;
    },
  };
}

describe('parseRepoConfig', () => {
  it('converts rules into risk rules', () => {
    const c = parseRepoConfig(`
rules:
  - glob: src/billing/**
    risk: high
    reason: Billing
  - glob: [a.ts, b.ts]
    pattern: 'eval\\('
    risk: medium
    reason: eval
notes: |
  careful
`);
    expect(c.rules).toEqual([
      { risk: 'high', reason: 'Billing', glob: 'src/billing/**' },
      { risk: 'medium', reason: 'eval', glob: ['a.ts', 'b.ts'], pattern: /eval\(/ },
    ]);
    expect(c.notes).toBe('careful');
  });

  it('accepts an empty file', () => {
    expect(parseRepoConfig('')).toEqual({ rules: [] });
  });

  it('rejects bad YAML, bad schema, bad regex and rules without a condition', () => {
    expect(() => parseRepoConfig('rules: [')).toThrow(/invalid YAML/);
    expect(() => parseRepoConfig('rules: 3')).toThrow(/rules/);
    expect(() => parseRepoConfig('rules:\n  - {glob: a, risk: severe, reason: x}')).toThrow(/risk/);
    expect(() => parseRepoConfig("rules:\n  - {pattern: '(', risk: low, reason: x}")).toThrow(
      /regular expression/,
    );
    expect(() => parseRepoConfig('rules:\n  - {risk: low, reason: x}')).toThrow(
      /glob or a pattern/,
    );
  });
});

describe('loadRepoConfig', () => {
  it('returns the built-ins when there is no file', async () => {
    expect(await loadRepoConfig(client({}), ref, 'sha')).toEqual({
      rules: BUILTIN_RULES,
      hash: '',
    });
  });

  it('merges repo rules after the built-ins and falls back to .yml', async () => {
    const text = 'rules:\n  - {glob: "x/**", risk: high, reason: X}\nnotes: n';
    const c = await loadRepoConfig(client({ '.review-dash.yml': text }), ref, 'sha');
    expect(c.rules).toHaveLength(BUILTIN_RULES.length + 1);
    expect(c.rules.at(-1)).toMatchObject({ reason: 'X' });
    expect(c.notes).toBe('n');
    expect(c.warning).toBeUndefined();
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('hash changes with the file content', async () => {
    const a = await loadRepoConfig(client({ '.review-dash.yaml': 'notes: a' }), ref, 's');
    const b = await loadRepoConfig(client({ '.review-dash.yaml': 'notes: b' }), ref, 's');
    expect(a.hash).not.toBe(b.hash);
  });

  it('warns and keeps the built-ins for an invalid file', async () => {
    const c = await loadRepoConfig(client({ '.review-dash.yaml': 'rules: 3' }), ref, 'sha');
    expect(c.rules).toBe(BUILTIN_RULES);
    expect(c.warning).toMatch(/Ignoring \.review-dash\.yaml/);
    expect(c.hash).not.toBe('');
  });

  it('warns when the file cannot be read for another reason', async () => {
    const c = await loadRepoConfig(
      {
        async fetchFileContent() {
          throw new Error('boom');
        },
      },
      ref,
      'sha',
    );
    expect(c.warning).toMatch(/boom/);
    expect(c.rules).toBe(BUILTIN_RULES);
  });
});
