/**
 * Demo server: serves the built UI (`pnpm build` first) against an in-memory fake GitHub,
 * so the UI can be tried or smoke-tested without a token. Not part of the shipped CLI.
 *
 *   pnpm demo [--port 5175] [--self]     (--self: viewer is the PR author)
 *   kill -USR2 <pid>                      simulate a push; Refresh in the UI shows it
 *   DEMO_REREVIEW=1 pnpm demo            (seeds reviewed hunks at an older head, 2 new commits)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../src/core/diff/parse.js';
import type { RawFile } from '../src/core/diff/types.js';
import type { PrSummary, ReviewThread } from '../src/core/github/types.js';
import { configSchema } from '../src/core/llm/config.js';
import { FakeProvider } from '../src/core/llm/fake.js';
import { openStore } from '../src/core/store/index.js';
import { fakeGitHub, loadFixture, type FakeGitHub } from '../src/core/testing/fakes.testutil.js';
import { startServer, type RunningServer } from '../src/server/index.js';

const numbered = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

const GREET_OLD =
  [
    "import { sleep } from './sleep';",
    '',
    ...Array.from({ length: 14 }, (_, i) => `// helper note ${i + 1}`),
    'export function greet(name: string) {',
    '  return `Hello ${name}`;',
    '}',
    '',
    ...Array.from({ length: 20 }, (_, i) => `const filler${i + 1} = ${i + 1};`),
    'export function tail(): string {',
    "  const value = 'a';",
    '  return value;',
    '}',
    '',
    'export default greet;',
  ].join('\n') + '\n';

const GREET_NEW = GREET_OLD.replace(
  '  return `Hello ${name}`;',
  "  const prefix = 'Hello';\n  return `${prefix} ${name}`;",
)
  .replace("  const value = 'a';", "  const value = 'b'; // changed\n  const extra = 1;")
  .replace('export default greet;', 'export const retries = 3;\nexport default greet;');

const UTIL_OLD = 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n';
const UTIL_NEW =
  'def add(a, b):\n    """Add."""\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n';

const TEST_OLD =
  "import { greet } from '../src/greet';\n\ntest('greets', () => {\n  expect(greet('a')).toBe('Hello a');\n});\n";
const TEST_NEW =
  TEST_OLD + "\ntest('greets twice', () => {\n  expect(greet('b')).toBe('Hello b');\n});\n";

const README_OLD = numbered(30, (i) => `Line ${i} of the readme`);
const README_NEW = README_OLD.replace(
  'Line 12 of the readme',
  '    Line 12 of the readme  ',
).replace('Line 20 of the readme', 'Line 20 was rewritten');

/** A real unified diff body (from `@@` on) for two texts, via git. */
function patchFor(oldText: string, newText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-dash-demo-'));
  try {
    writeFileSync(join(dir, 'a'), oldText);
    writeFileSync(join(dir, 'b'), newText);
    let out = '';
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', 'a', 'b'], { cwd: dir });
    } catch (err) {
      out = String((err as { stdout?: Buffer }).stdout ?? ''); // exit 1 = differences
    }
    return out.slice(out.indexOf('@@')).trimEnd();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (patch: string, ch: '+' | '-') =>
  patch.split('\n').filter((l) => l.startsWith(ch) && !l.startsWith(ch.repeat(3))).length;

function file(filename: string, oldText: string, newText: string): RawFile {
  const patch = patchFor(oldText, newText);
  const additions = count(patch, '+');
  const deletions = count(patch, '-');
  return {
    filename,
    status: 'modified',
    additions,
    deletions,
    changes: additions + deletions,
    patch,
  };
}

export interface Demo {
  server: RunningServer;
  url: string;
  github: FakeGitHub;
  /** Simulates a push: new head sha and a changed greet.ts hunk, picked up by the next Refresh. */
  moveHead(): void;
  close(): Promise<void>;
}

/** Canned grouping so the demo shows real groups without an LLM: one group per source area. */
function demoGrouping(prompt: string): string {
  const hunks = [...prompt.matchAll(/## hunk (\S+)\npath: (\S+)/g)].map((m) => ({
    id: m[1]!,
    path: m[2]!,
  }));
  const ids = (re: RegExp) => hunks.filter((h) => re.test(h.path)).map((h) => h.id);
  const groups = [
    {
      title: 'Greeting prefix and retry constant',
      intent: 'Makes the greeting prefix a variable and adds a retries export.',
      kind: 'feature',
      risk: 'high',
      risk_reasons: ['Changes the public greet() output path', 'New exported constant'],
      verify: ['greet() output is unchanged for existing callers', 'retries is not shadowed'],
      hunk_ids: ids(/^src\/greet\.ts$/),
      depends_on: [1],
    },
    {
      title: 'Math helpers',
      intent: 'Documents add() and introduces mul().',
      kind: 'feature',
      risk: 'low',
      risk_reasons: [],
      verify: ['mul() has the same signature style as add()'],
      hunk_ids: ids(/^src\/util\.py$/),
      depends_on: [],
    },
    {
      title: 'Tests for greet',
      intent: 'Adds a second greet test.',
      kind: 'test',
      risk: 'low',
      risk_reasons: [],
      verify: [],
      hunk_ids: ids(/^tests\//),
      depends_on: [0],
    },
  ].filter((g) => g.hunk_ids.length > 0);
  return JSON.stringify({
    summary:
      'Refactors greet() to use a prefix variable, adds a retries constant and a mul() helper, and extends the tests.',
    groups,
    unrelated_or_suspicious: ['README.md whitespace edits look unrelated to the code changes.'],
  });
}

export async function startDemo(
  /** `picker` starts on the open-PR list instead of PR #1. */
  opts: { port?: number; self?: boolean; rereview?: boolean; picker?: boolean } = {},
): Promise<Demo> {
  const fx = loadFixture();
  const contents: Record<string, [string, string]> = {
    'src/greet.ts': [GREET_OLD, GREET_NEW],
    'src/util.py': [UTIL_OLD, UTIL_NEW],
    'README.md': [README_OLD, README_NEW],
    'tests/greet.test.ts': [TEST_OLD, TEST_NEW],
  };
  const files: RawFile[] = [
    ...Object.entries(contents).map(([p, [o, n]]) => file(p, o, n)),
    { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
    {
      filename: 'package-lock.json',
      status: 'modified',
      additions: 2000,
      deletions: 1000,
      changes: 3000,
    },
  ];
  const github = fakeGitHub({
    files,
    viewer: opts.self ? fx.pr.author : fx.viewer,
    pr: { ...fx.pr, changedFiles: files.length, additions: 14, deletions: 6 },
  });
  github.fetchFileContent = async (_ref, path, sha) => {
    const pair = contents[path];
    if (!pair) throw Object.assign(new Error(`no such file ${path}`), { status: 404 });
    return sha === fx.pr.baseSha ? pair[0] : pair[1];
  };
  const thread = (
    id: string,
    resolved: boolean,
    line: number,
    body: string,
    path = 'src/greet.ts',
  ): ReviewThread => ({
    id,
    isResolved: resolved,
    isOutdated: false,
    path,
    line,
    originalLine: line,
    diffSide: 'RIGHT',
    startLine: null,
    comments: [
      {
        id: `${id}-c1`,
        databaseId: Number(id.replace(/\D/g, '')) || 1,
        author: 'octocat',
        body,
        createdAt: '2026-01-02T10:00:00Z',
        url: 'https://github.com/octocat/hello-world/pull/1#discussion_r1',
      },
    ],
  });
  github.threads = [
    thread('t1', false, 17, 'Should this prefix be configurable?'),
    thread('t2', true, 22, 'Nit: fixed in the next commit.'),
    // Files without a rendered diff still show their discussion.
    thread('t3', false, 1, 'Can we compress this logo?', 'assets/logo.png'),
  ];

  const prRef = { owner: 'octocat', repo: 'hello-world', number: 1 };
  // Every listed PR serves the same fixture diff.
  const summary = (
    number: number,
    title: string,
    author: string,
    hoursAgo: number,
    extra: Partial<PrSummary> = {},
  ): PrSummary => ({
    number,
    title,
    author,
    draft: false,
    url: `https://github.com/octocat/hello-world/pull/${number}`,
    headRef: `feature-${number}`,
    baseRef: 'main',
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    labels: [],
    requestedReviewers: [],
    ...extra,
  });
  github.openPrs = [
    summary(1, fx.pr.title, fx.pr.author, 1, {
      labels: ['enhancement'],
      requestedReviewers: ['octocat'],
    }),
    summary(7, 'Retry webhook deliveries with backoff', 'hubot', 26),
    summary(12, 'WIP: migrate config loader to zod', 'monalisa', 200, {
      draft: true,
      labels: ['wip'],
    }),
  ];
  const store = openStore(':memory:');
  if (opts.rereview) {
    // The user reviewed the Python and test hunks at an older head; two commits landed since.
    const oldHead = 'a'.repeat(40);
    const ids = files
      .filter((f) => /^(src\/util\.py|tests\/)/.test(f.filename))
      .flatMap((f) => parseFile(f).hunks.map((h) => h.id));
    store.markReviewed(prRef, ids, oldHead);
    github.compare = {
      commits: [
        {
          sha: 'b1b2b3b4b5b6b7b8b9b0b1b2b3b4b5b6b7b8b9b0',
          message: 'Make the greeting prefix a variable',
          author: 'octocat',
          date: '2026-01-03T09:00:00Z',
        },
        {
          sha: 'c1c2c3c4c5c6c7c8c9c0c1c2c3c4c5c6c7c8c9c0',
          message: 'Add retries constant',
          author: 'octocat',
          date: '2026-01-03T10:00:00Z',
        },
      ],
      files: ['src/greet.ts', 'README.md'],
      totalCommits: 2,
    };
  }

  const server = await startServer({
    repo: { owner: prRef.owner, repo: prRef.repo },
    initialPr: opts.picker ? undefined : prRef.number,
    port: opts.port ?? 0,
    github,
    store,
    analysis: {
      config: configSchema.parse({ provider: 'openrouter' }),
      createProvider: () =>
        new FakeProvider(
          Array.from({ length: 50 }, () => (req) => demoGrouping(req.prompt)),
          'fake',
        ),
    },
  });
  let moves = 0;
  const moveHead = () => {
    moves++;
    const idx = files.findIndex((f) => f.filename === 'src/greet.ts');
    files[idx] = file('src/greet.ts', GREET_OLD, GREET_NEW.replace("'Hello'", `'Hello${moves}'`));
    github.setHead(String(moves).repeat(40).slice(0, 40));
  };
  return {
    server,
    github,
    moveHead,
    url: `http://127.0.0.1:${server.port}/#token=${server.token}`,
    close: server.close,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIdx = process.argv.indexOf('--port');
  const demo = await startDemo({
    port: portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 5175,
    self: process.argv.includes('--self'),
    rereview: process.env.DEMO_REREVIEW === '1',
    picker: process.argv.includes('--picker'),
  });
  console.log(`Demo (fake GitHub): ${demo.url}`);
  // Smoke tests: `kill -USR2 <pid>` simulates a push; click Refresh in the UI to pick it up.
  process.on('SIGUSR2', () => demo.moveHead());
  process.on('SIGINT', () => void demo.close().then(() => process.exit(0)));
}
