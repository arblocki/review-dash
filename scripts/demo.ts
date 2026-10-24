/**
 * Demo server: serves the built UI (`pnpm build` first) against an in-memory fake GitHub,
 * so the UI can be tried or smoke-tested without a token. Not part of the shipped CLI.
 *
 *   pnpm demo [--port 5175] [--self]     (--self: viewer is the PR author)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawFile } from '../src/core/diff/types.js';
import type { ReviewThread } from '../src/core/github/types.js';
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
  close(): Promise<void>;
}

export async function startDemo(opts: { port?: number; self?: boolean } = {}): Promise<Demo> {
  const fx = loadFixture();
  const contents: Record<string, [string, string]> = {
    'src/greet.ts': [GREET_OLD, GREET_NEW],
    'src/util.py': [UTIL_OLD, UTIL_NEW],
    'README.md': [README_OLD, README_NEW],
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
    if (!pair) throw new Error(`no such file ${path}`);
    return sha === fx.pr.baseSha ? pair[0] : pair[1];
  };
  const thread = (id: string, resolved: boolean, line: number, body: string): ReviewThread => ({
    id,
    isResolved: resolved,
    isOutdated: false,
    path: 'src/greet.ts',
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
  ];

  const server = await startServer({
    pr: { owner: 'octocat', repo: 'hello-world', number: 1 },
    port: opts.port ?? 0,
    github,
    store: openStore(':memory:'),
  });
  return {
    server,
    github,
    url: `http://127.0.0.1:${server.port}/#token=${server.token}`,
    close: server.close,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIdx = process.argv.indexOf('--port');
  const demo = await startDemo({
    port: portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 5175,
    self: process.argv.includes('--self'),
  });
  console.log(`Demo (fake GitHub): ${demo.url}`);
  process.on('SIGINT', () => void demo.close().then(() => process.exit(0)));
}
