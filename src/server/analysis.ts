import type { Hono } from 'hono';
import { analyzePr, PROMPT_VERSION, type Analysis } from '../core/group/index.js';
import {
  ConfigError,
  LlmError,
  PROVIDER_IDS,
  isProviderId,
  type LlmConfig,
  type LlmProvider,
  type ProviderId,
} from '../core/llm/index.js';
import type { GitHubClient } from '../core/github/types.js';
import type { PrData } from '../core/pr-data.js';
import type { PrRef } from '../core/pr-ref.js';
import type { Store } from '../core/store/index.js';

export interface ProviderSelection {
  provider: ProviderId;
  model: string;
}

/** Everything the analysis routes need from the outside; tests inject a fake factory. */
export interface AnalysisDeps {
  /** Effective config (CLI --provider/--model already applied). */
  config: LlmConfig;
  createProvider(sel: ProviderSelection): LlmProvider;
}

interface RouteDeps {
  pr: PrRef;
  github: GitHubClient;
  store: Store;
  getData: () => Promise<PrData>;
  analysis: AnalysisDeps;
}

function status(err: unknown): { status: 400 | 409 | 500 | 504; code: string } {
  if (err instanceof ConfigError) return { status: 409, code: 'config' };
  if (err instanceof LlmError) {
    if (err.kind === 'not_installed' || err.kind === 'auth') return { status: 409, code: err.kind };
    if (err.kind === 'timeout') return { status: 504, code: err.kind };
    return { status: 500, code: err.kind };
  }
  return { status: 500, code: 'analysis_failed' };
}

/** GET /api/analysis and GET /api/providers. */
export function registerAnalysisApi(app: Hono, deps: RouteDeps): void {
  const { pr: ref, github, store, getData, analysis: a } = deps;
  const inflight = new Map<string, Promise<Analysis>>();

  const selection = (query: { provider?: string; model?: string }): ProviderSelection | string => {
    const provider = query.provider || a.config.provider;
    if (!isProviderId(provider)) {
      return `Unknown provider "${provider}". Expected one of: ${PROVIDER_IDS.join(', ')}`;
    }
    return { provider, model: query.model || a.config.models[provider] };
  };

  app.get('/api/providers', (c) =>
    c.json({
      current: { provider: a.config.provider, model: a.config.models[a.config.provider] },
      available: [...PROVIDER_IDS],
      models: a.config.models,
    }),
  );

  app.get('/api/analysis', async (c) => {
    const sel = selection({ provider: c.req.query('provider'), model: c.req.query('model') });
    if (typeof sel === 'string') return c.json({ error: sel, code: 'bad_request' }, 400);
    const force = c.req.query('force') === '1';

    try {
      const data = await getData();
      const key = {
        headSha: data.pr.headSha,
        diffHash: data.diffHash,
        provider: sel.provider,
        model: sel.model,
        promptVersion: PROMPT_VERSION,
      };
      if (!force) {
        const hit = store.getAnalysis(ref, key);
        if (hit) return c.json({ analysis: hit, cached: true });
      }

      const flightKey = JSON.stringify(key);
      let flight = inflight.get(flightKey);
      const shared = flight !== undefined;
      if (!flight) {
        flight = runAnalysis(sel, data).then((result) => {
          // A fallback result is not cached: the next open should retry the model.
          if (!result.fallback) store.saveAnalysis(ref, key, result);
          return result;
        });
        inflight.set(flightKey, flight);
        const clear = () => inflight.delete(flightKey);
        flight.then(clear, clear);
      }
      return c.json({ analysis: await flight, cached: false, shared });
    } catch (err) {
      const { status: code, code: kind } = status(err);
      return c.json({ error: (err as Error).message, code: kind }, code);
    }
  });

  async function runAnalysis(sel: ProviderSelection, data: PrData): Promise<Analysis> {
    const provider = a.createProvider(sel);
    let mapProvider: LlmProvider | undefined;
    const mapId = a.config.mapProvider;
    if (mapId) {
      try {
        mapProvider = a.createProvider({ provider: mapId, model: a.config.models[mapId] });
      } catch {
        mapProvider = undefined; // map step falls back to the main provider
      }
    }
    const reviewMd = await github
      .fetchFileContent(ref, 'REVIEW.md', data.pr.headSha)
      .catch(() => undefined);
    return analyzePr({
      pr: { title: data.pr.title, body: data.pr.body },
      files: data.files,
      provider,
      model: sel.model,
      mapProvider,
      reviewMd,
      config: { maxConcurrency: a.config.maxConcurrency },
    });
  }
}
