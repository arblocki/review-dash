import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../paths.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { CodexCliProvider } from './codex-cli.js';
import { OpenRouterProvider } from './openrouter.js';
import { PROVIDER_IDS, type LlmProvider, type ProviderId } from './types.js';

const providerId = z.enum(PROVIDER_IDS);

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  'claude-cli': 'sonnet',
  'codex-cli': 'gpt-5-codex',
  openrouter: 'anthropic/claude-sonnet-4.5',
};

export const configSchema = z.object({
  provider: providerId.default('claude-cli'),
  models: z
    .object({
      'claude-cli': z.string().min(1).default(DEFAULT_MODELS['claude-cli']),
      'codex-cli': z.string().min(1).default(DEFAULT_MODELS['codex-cli']),
      openrouter: z.string().min(1).default(DEFAULT_MODELS.openrouter),
    })
    .default(DEFAULT_MODELS),
  mapProvider: providerId.optional(),
  maxConcurrency: z.number().int().min(1).max(32).default(4),
});

export type LlmConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function configPath(dir: string = configDir()): string {
  return join(dir, 'config.json');
}

/** Load ~/.config/review-dash/config.json; missing file means defaults. */
export function loadConfig(dir: string = configDir()): LlmConfig {
  const file = configPath(dir);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({});
    throw new ConfigError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config in ${file}:\n${issues}`);
  }
  return parsed.data;
}

export interface ProviderOverrides {
  provider?: string;
  model?: string;
}

export interface ProviderDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export function createProvider(
  config: LlmConfig,
  overrides: ProviderOverrides = {},
  deps: ProviderDeps = {},
): LlmProvider {
  const id = overrides.provider ?? config.provider;
  const parsed = providerId.safeParse(id);
  if (!parsed.success) {
    throw new ConfigError(`Unknown provider "${id}". Expected one of: ${PROVIDER_IDS.join(', ')}`);
  }
  const model = overrides.model ?? config.models[parsed.data];
  switch (parsed.data) {
    case 'claude-cli':
      return new ClaudeCliProvider({ model });
    case 'codex-cli':
      return new CodexCliProvider({ model });
    case 'openrouter': {
      const apiKey = (deps.env ?? process.env).OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new ConfigError(
          'OPENROUTER_API_KEY is not set. Export it or put it in .env (never commit it).',
        );
      }
      return new OpenRouterProvider({ apiKey, model, fetch: deps.fetch });
    }
  }
}
