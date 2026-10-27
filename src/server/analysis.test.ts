import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION } from '../core/group/index.js';
import { configSchema, FakeProvider, LlmError, type LlmProvider } from '../core/llm/index.js';
import { openStore } from '../core/store/index.js';
import { fakeGitHub } from '../core/testing/fakes.testutil.js';
import { createApp } from './app.js';
import { TOKEN_HEADER } from './security.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const PORT = 4321;
const pr = { owner: 'octocat', repo: 'hello-world', number: 1 };

function reply(req: { prompt: string }): string {
  const ids = [...req.prompt.matchAll(/^## hunk ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
  return JSON.stringify({
    summary: 'fake summary',
    unrelated_or_suspicious: [],
    groups: [
      {
        title: 'All',
        intent: 'everything',
        kind: 'feature',
        risk: 'low',
        risk_reasons: [],
        verify: ['check'],
        hunk_ids: ids,
        depends_on: [],
      },
    ],
  });
}

function setup(make: () => LlmProvider) {
  const github = fakeGitHub();
  const store = openStore(':memory:');
  const created: { provider: string; model: string }[] = [];
  const app = createApp({
    token: 't',
    pr,
    port: () => PORT,
    github,
    store,
    analysis: {
      config: configSchema.parse({}),
      createProvider: (sel) => {
        created.push(sel);
        return make();
      },
    },
  });
  const get = async (path: string): Promise<{ status: number; json: Json }> => {
    const res = await app.request(path, {
      headers: { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: 't' },
    });
    return { status: res.status, json: await res.json() };
  };
  return { get, store, created, github };
}

describe('GET /api/providers', () => {
  it('reports current selection and available ids', async () => {
    const { get } = setup(() => new FakeProvider([]));
    const r = await get('/api/providers');
    expect(r.status).toBe(200);
    expect(r.json.current).toEqual({ provider: 'claude-cli', model: 'sonnet' });
    expect(r.json.available).toEqual(['claude-cli', 'codex-cli', 'openrouter']);
  });
});

describe('GET /api/analysis', () => {
  it('runs the analysis, caches it, and re-runs on force', async () => {
    const providers: FakeProvider[] = [];
    const { get, created } = setup(() => {
      const p = new FakeProvider([reply, reply]);
      providers.push(p);
      return p;
    });
    const first = await get('/api/analysis');
    expect(first.status).toBe(200);
    expect(first.json.cached).toBe(false);
    expect(first.json.analysis.summary).toBe('fake summary');
    expect(first.json.analysis.promptVersion).toBe(PROMPT_VERSION);
    const groups = first.json.analysis.groups;
    expect(groups.find((g: Json) => g.title === 'All')).toMatchObject({
      title: 'All',
      risk: 'medium',
      dependsOn: [],
      autoClear: false,
    });
    // The fixture also has a pure rename, a binary and a patch-less lockfile.
    expect(groups.map((g: Json) => g.title)).toEqual([
      'All',
      'Files without a diff — review on GitHub',
      'Mechanical changes',
    ]);
    expect(groups[1]).toMatchObject({
      files: ['assets/logo.png', 'package-lock.json'],
      autoClear: false,
    });
    expect(groups[2].files).toEqual(['src/hello.ts']);
    expect(groups[0].riskReasons).toContain('Changes exported (public API) declarations');

    const second = await get('/api/analysis');
    expect(second.json.cached).toBe(true);
    expect(second.json.analysis).toEqual(first.json.analysis);
    expect(created).toHaveLength(1);

    const forced = await get('/api/analysis?force=1');
    expect(forced.json.cached).toBe(false);
    expect(created).toHaveLength(2);

    // A different model is a different cache key.
    const other = await get('/api/analysis?provider=openrouter&model=x%2Fy');
    expect(other.json.cached).toBe(false);
    expect(created.at(-1)).toEqual({ provider: 'openrouter', model: 'x/y' });
  });

  it('re-analyzes when the PR title or body changes at the same head', async () => {
    const { get, github, created } = setup(() => new FakeProvider([reply]));
    const refresh = async () => {
      const res = await get('/api/pr?refresh=1');
      expect(res.status).toBe(200);
    };
    expect((await get('/api/analysis')).json.cached).toBe(false);
    await refresh();
    expect((await get('/api/analysis')).json.cached).toBe(true);

    github.setMeta({ body: 'A new description' });
    await refresh();
    expect((await get('/api/analysis')).json.cached).toBe(false);
    expect((await get('/api/analysis')).json.cached).toBe(true);

    github.setMeta({ title: 'A new title' });
    await refresh();
    expect((await get('/api/analysis')).json.cached).toBe(false);
    expect(created).toHaveLength(3); // one provider (and one model call) per real analysis
  });

  it('shares one in-flight analysis between concurrent requests', async () => {
    let calls = 0;
    const { get } = setup(
      () =>
        new FakeProvider([
          (req) => {
            calls++;
            return reply(req);
          },
        ]),
    );
    const [a, b] = await Promise.all([get('/api/analysis'), get('/api/analysis')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('passes REVIEW.md to the model when the repo has one', async () => {
    const p = new FakeProvider([reply]);
    const { get, github } = setup(() => p);
    github.fetchFileContent = async (_r, path) => {
      if (path === 'REVIEW.md') return 'Be careful with retries';
      throw new Error('404');
    };
    await get('/api/analysis');
    expect(p.requests[0]!.prompt).toContain('Be careful with retries');
  });

  it('works without REVIEW.md (404 ignored)', async () => {
    const p = new FakeProvider([reply]);
    const { get, github } = setup(() => p);
    github.fetchFileContent = async () => {
      throw new Error('404');
    };
    expect((await get('/api/analysis')).status).toBe(200);
  });

  it('returns 409 with a code for not_installed / auth / unsupported, 500 otherwise', async () => {
    for (const [kind, status] of [
      ['not_installed', 409],
      ['auth', 409],
      ['unsupported', 409],
      ['http', 500],
    ] as const) {
      const { get } = setup(() => new FakeProvider([new LlmError(kind, `boom ${kind}`)]));
      const r = await get('/api/analysis');
      expect(r.status).toBe(status);
      expect(r.json).toEqual({ error: `boom ${kind}`, code: kind });
    }
  });

  it('does not cache failures or fallback results', async () => {
    const { get, created } = setup(() => new FakeProvider(['bad', 'bad']));
    const a = await get('/api/analysis');
    expect(a.json.analysis.fallback).toBe(true);
    const b = await get('/api/analysis');
    expect(b.json.cached).toBe(false);
    expect(created).toHaveLength(2);
  });

  it('rejects an unknown provider', async () => {
    const { get } = setup(() => new FakeProvider([]));
    const r = await get('/api/analysis?provider=nope');
    expect(r.status).toBe(400);
  });
});
