import { createHash } from 'node:crypto';
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
import { loadRepoConfig, type LoadedRepoConfig } from '../core/risk/index.js';
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
  /** CLI --trust-pr-config: read .review-dash.yaml and REVIEW.md at the PR head, not the base. */
  trustPrConfig?: boolean;
}

interface Policy {
  source: 'base' | 'head';
  config: LoadedRepoConfig;
  reviewMd?: string;
  /** Set when the PR's own rules file was ignored. */
  notice?: string;
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
    // The user can fix these locally (install, log in, or upgrade the CLI), so not a 5xx.
    if (err.kind === 'not_installed' || err.kind === 'auth' || err.kind === 'unsupported') {
      return { status: 409, code: err.kind };
    }
    if (err.kind === 'timeout') return { status: 504, code: err.kind };
    return { status: 500, code: err.kind };
  }
  return { status: 500, code: 'analysis_failed' };
}

/** The prompt includes the PR title and body, so editing them must miss the cache. */
function contextHash(pr: { title: string; body: string }): string {
  return createHash('sha1')
    .update(pr.title)
    .update('\0')
    .update(pr.body)
    .digest('hex')
    .slice(0, 12);
}

/** Cache-key part for the policy used: its source, rules file hash and REVIEW.md hash. */
function policyKey(policy: Policy): string {
  const rules = policy.config.hash ? `+rules:${policy.config.hash.slice(0, 12)}` : '';
  const md = policy.reviewMd
    ? `+md:${createHash('sha1').update(policy.reviewMd).digest('hex').slice(0, 12)}`
    : '';
  return `${PROMPT_VERSION}${rules}${md}@${policy.source}`;
}

/** GET /api/analysis and GET /api/providers. */
export function registerAnalysisApi(app: Hono, deps: RouteDeps): void {
  const { pr: ref, github, store, getData, analysis: a } = deps;
  const inflight = new Map<string, Promise<Analysis>>();
  // Files are read once per commit SHA.
  const configs = new Map<string, Promise<LoadedRepoConfig>>();
  const getConfig = (sha: string): Promise<LoadedRepoConfig> => {
    let p = configs.get(sha);
    if (!p) {
      p = loadRepoConfig(github, ref, sha);
      configs.set(sha, p);
    }
    return p;
  };
  const reviewMds = new Map<string, Promise<string | undefined>>();
  const getReviewMd = (sha: string): Promise<string | undefined> => {
    let p = reviewMds.get(sha);
    if (!p) {
      p = github.fetchFileContent(ref, 'REVIEW.md', sha).then(
        (t) => t.trim() || undefined,
        () => undefined,
      );
      reviewMds.set(sha, p);
    }
    return p;
  };

  /**
   * The review policy (rules, notes, REVIEW.md) is trusted only from the PR's base commit: the
   * PR itself could otherwise change its own rules. If the head's .review-dash.yaml differs from
   * the base's it is not used, unless the user passed --trust-pr-config.
   */
  async function resolvePolicy(pr: { baseSha: string; headSha: string }): Promise<Policy> {
    if (a.trustPrConfig) {
      return {
        source: 'head',
        config: await getConfig(pr.headSha),
        reviewMd: await getReviewMd(pr.headSha),
      };
    }
    const [base, head] = await Promise.all([getConfig(pr.baseSha), getConfig(pr.headSha)]);
    const reviewMd = await getReviewMd(pr.baseSha);
    const changed = base.hash !== head.hash;
    return {
      source: 'base',
      config: base,
      reviewMd,
      ...(changed
        ? {
            notice:
              "This PR changes .review-dash.yaml; using the base branch's rules. Re-run with --trust-pr-config to use the PR's version.",
          }
        : {}),
    };
  }

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
      if (force) {
        for (const sha of [data.pr.baseSha, data.pr.headSha]) {
          configs.delete(sha);
          reviewMds.delete(sha);
        }
      }
      const policy = await resolvePolicy(data.pr);
      const repoConfig = policy.config;
      const configWarning = repoConfig.warning;
      const warn = {
        ...(configWarning ? { configWarning } : {}),
        ...(policy.notice ? { configNotice: policy.notice } : {}),
      };
      // Editing .review-dash.yaml changes the key, so cached analyses are not reused.
      const key = {
        headSha: data.pr.headSha,
        // Folded into the existing key column to avoid a schema migration.
        diffHash: `${data.diffHash}+${contextHash(data.pr)}`,
        provider: sel.provider,
        model: sel.model,
        promptVersion: policyKey(policy),
      };
      // Which PR version this analysis describes, so the UI can tell when it has gone stale.
      const computedFor = { headSha: data.pr.headSha, diffHash: data.diffHash };
      if (!force) {
        const hit = store.getAnalysis(ref, key);
        if (hit) return c.json({ analysis: hit, cached: true, ...computedFor, ...warn });
      }

      const flightKey = JSON.stringify(key);
      let flight = inflight.get(flightKey);
      const shared = flight !== undefined;
      if (!flight) {
        flight = runAnalysis(sel, data, policy).then((result) => {
          // A fallback result is not cached: the next open should retry the model.
          if (!result.fallback) store.saveAnalysis(ref, key, result);
          return result;
        });
        inflight.set(flightKey, flight);
        const clear = () => inflight.delete(flightKey);
        flight.then(clear, clear);
      }
      return c.json({ analysis: await flight, cached: false, shared, ...computedFor, ...warn });
    } catch (err) {
      const { status: code, code: kind } = status(err);
      return c.json({ error: (err as Error).message, code: kind }, code);
    }
  });

  async function runAnalysis(
    sel: ProviderSelection,
    data: PrData,
    policy: Policy,
  ): Promise<Analysis> {
    const repoConfig = policy.config;
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
    const notes = repoConfig.notes
      ? `# Repo risk notes (.review-dash.yaml)\n${repoConfig.notes}`
      : undefined;
    return analyzePr({
      pr: { title: data.pr.title, body: data.pr.body },
      files: data.files,
      provider,
      model: sel.model,
      mapProvider,
      reviewMd: [policy.reviewMd, notes].filter(Boolean).join('\n\n') || undefined,
      rules: repoConfig.rules,
      config: { maxConcurrency: a.config.maxConcurrency },
    });
  }
}
