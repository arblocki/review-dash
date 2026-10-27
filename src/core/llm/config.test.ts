import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, createProvider, loadConfig } from './config.js';

const dirs: string[] = [];
function tmp(config?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'rd-config-'));
  dirs.push(d);
  if (config !== undefined) writeFileSync(join(d, 'config.json'), config);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('loadConfig', () => {
  it('returns defaults when the file is missing', () => {
    expect(loadConfig(tmp())).toEqual({
      provider: 'claude-cli',
      models: {
        'claude-cli': 'sonnet',
        'codex-cli': 'gpt-5-codex',
        openrouter: 'anthropic/claude-sonnet-4.5',
      },
      maxConcurrency: 4,
    });
  });

  it('merges partial config over defaults', () => {
    const c = loadConfig(
      tmp(
        JSON.stringify({
          provider: 'openrouter',
          models: { openrouter: 'x/y' },
          mapProvider: 'codex-cli',
        }),
      ),
    );
    expect(c.provider).toBe('openrouter');
    expect(c.models).toMatchObject({ openrouter: 'x/y', 'claude-cli': 'sonnet' });
    expect(c.mapProvider).toBe('codex-cli');
  });

  it('gives clear errors for invalid files', () => {
    expect(() => loadConfig(tmp('{nope'))).toThrow(/Invalid JSON/);
    expect(() => loadConfig(tmp('{"provider":"gpt"}'))).toThrow(ConfigError);
    expect(() => loadConfig(tmp('{"maxConcurrency":0}'))).toThrow(/maxConcurrency/);
  });
});

describe('createProvider', () => {
  const config = loadConfig(tmp());
  it('applies overrides', () => {
    expect(createProvider(config, { provider: 'codex-cli' }).id).toBe('codex-cli');
    expect(createProvider(config).id).toBe('claude-cli');
  });
  it('requires OPENROUTER_API_KEY', () => {
    expect(() => createProvider(config, { provider: 'openrouter' }, { env: {} })).toThrow(
      /OPENROUTER_API_KEY/,
    );
    expect(
      createProvider(config, { provider: 'openrouter' }, { env: { OPENROUTER_API_KEY: 'k' } }).id,
    ).toBe('openrouter');
  });
  it('rejects unknown providers', () => {
    expect(() => createProvider(config, { provider: 'x' })).toThrow(ConfigError);
  });
});
