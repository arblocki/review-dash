# review-dash: MVP Plan

A local, single-user tool for reviewing big (usually AI-generated) GitHub pull requests.
It takes an existing PR, sorts the diff into small groups of related changes, labels each
group and gives it a risk level, shows the groups riskiest first, and lets me leave comments
that are posted back to GitHub as a normal review.

## 1. Scope

### In scope (MVP)
- Start from a PR that already exists on GitHub (`review-dash owner/repo#123` or a PR URL).
- Read the diff and split it into hunks, each with a stable ID.
- Group related hunks with an LLM, with cheap deterministic rules running before it.
- For each group: a title, a one-line intent, a risk level with reasons, and a short
  "what to verify" checklist.
- A clean diff UI: groups in a left rail, the group's hunks in the main pane, expandable
  context, syntax highlighting, keyboard navigation.
- Inline comments on any diff line, saved locally as drafts, submitted as one GitHub review
  (Comment / Approve / Request changes).
- A "reviewed" checkbox per hunk that persists, so after a new push I only see what changed.
- Pluggable LLM backends: Claude subscription (via the `claude` CLI), Codex subscription
  (via the `codex` CLI), and OpenRouter (API key).

### Out of scope (for now)
- Writing plans for coding agents, generating code, or applying review feedback. That stays
  in Claude Code / Codex / wherever.
- Finding bugs automatically. Use `/code-review` or similar for that. This tool is for
  *understanding* a PR, not auditing it. (A later version could show those findings
  next to the groups they touch.)
- Multiple users, hosting, auth, teams. It runs on my machine, on localhost only.
- Creating or managing stacked PRs.

### What success looks like
- A 2,000-line agent PR reads as roughly 5–15 groups, each one coherent enough to review on
  its own.
- Mechanical noise (lockfiles, generated code, snapshots, pure renames) collapses into one
  group that is low risk and can be cleared without reading it.
- Every hunk lands in exactly one group. Nothing can be silently skipped.
- Review time per PR goes down. Track this informally, just by noting how long reviews take.

## 2. Architecture

```
            ┌───────────────────────── review-dash (local Node process) ──────────────────────────┐
 CLI ──────▶│  ingest ─▶ parse ─▶ classify ─▶ pre-group ─▶ LLM refine ─▶ validate ─▶ risk ─▶ order │
            │     │                                       │                                       │
            │  GitHub API                           LLM provider                                  │
            │  (Octokit)                    (claude CLI / codex CLI / OpenRouter)                 │
            │                                                                                     │
            │  SQLite (~/.review-dash/): analysis cache, draft comments, reviewed-hunk state      │
            │                                                                                     │
            │  HTTP API on 127.0.0.1 ◀──────────▶ React UI in the browser                         │
            └─────────────────────────────────────────────────────────────────────────────────────┘
```

### Tech choices
| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language for CLI, server, and UI; good GitHub and LLM SDKs |
| Runtime / package manager | Node 22+, pnpm | Standard choices |
| Server | Hono (or Fastify) | Small, typed, easy to serve the built UI too |
| UI | React + Vite + Tailwind | Fast to build |
| Diff rendering | `react-diff-view` (+ `refractor` or Shiki for highlighting) | Hunk-based model, supports inline "widgets" for comment threads |
| GitHub | `@octokit/rest` + `@octokit/graphql` | REST for files and reviews, GraphQL for review threads |
| Storage | `better-sqlite3` in `~/.review-dash/review-dash.db` | Local and durable; never inside the repo |
| Validation | `zod` | Checks LLM JSON output and API payloads |
| Code structure (v2) | `web-tree-sitter` | Maps hunks to enclosing symbols, finds def-use edges |

Start as a single package with `src/cli`, `src/server`, `src/core`, `src/web`. Split into
a monorepo only if that becomes painful.

## 3. GitHub integration

### Auth (no secrets in the repo)
In order of preference:
1. `gh auth token`, if the GitHub CLI is installed and logged in. Nothing to configure.
2. The `GITHUB_TOKEN` env var, read from the shell or a gitignored `.env`.
3. A fine-grained PAT with **Pull requests: read & write** and **Contents: read** on the repos
   I review.

The token is only held in memory. It is never written to SQLite, logs, or the browser.

### What we read
- PR metadata: `GET /repos/{o}/{r}/pulls/{n}` gives title, body, base/head SHAs, author.
- Changed files with patches: `GET /pulls/{n}/files`, paginated, up to 3,000 files. GitHub
  leaves out `patch` for very large files. For those, fall back to fetching the full diff
  (`Accept: application/vnd.github.diff`) or comparing base and head blobs locally.
- File contents at base and head, for expanding context and for tree-sitter:
  `GET /contents/{path}?ref={sha}`, fetched lazily and cached by blob SHA.
- Existing review threads, via GraphQL `pullRequest.reviewThreads`. Shown inline so I can
  see what's already been said and whether it's resolved.
- Commits on the PR, used to detect new pushes for the interdiff.

### What we write
- **One review per submission**: `POST /pulls/{n}/reviews` with `commit_id = headSha`,
  `event` (COMMENT / APPROVE / REQUEST_CHANGES), `body`, and `comments[]`.
- Each comment needs `path`, `line`, `side` (`RIGHT` for added and context lines, `LEFT`
  for deleted lines), plus `start_line`/`start_side` if it covers more than one line.
- GitHub only accepts inline comments on lines that are inside the diff hunks. If I
  comment on an expanded-context line outside a hunk, the draft goes into the review body
  as `path:line — comment`, with a warning in the UI first.
- Replies to existing threads go through
  `POST /pulls/{n}/comments/{id}/replies`. Resolving threads uses the GraphQL
  `resolveReviewThread` mutation (nice to have).
- If the head SHA moved since I started, warn before submitting. Drafts get re-anchored to
  the new diff or flagged as outdated.

### Self-review caveat
GitHub doesn't let you APPROVE or REQUEST_CHANGES on your own PR, and agent PRs opened
under my account count as mine. In that case, hide those buttons and submit as COMMENT.

## 4. Analysis pipeline

### 4.1 Parse
- Turn each file patch into hunks: `{ id, path, oldPath?, status, oldStart, oldLines,
  newStart, newLines, header, lines[] }`.
- **Hunk ID** = `sha1(path + normalized hunk content)`, with line numbers left out, so the
  ID survives rebases that shift lines. This is what reviewed state and caching key on.
- Hunks are the units that get grouped. v1 never splits a hunk. v2 may let the LLM split
  an oversized hunk by line range.

### 4.2 Classify (deterministic, free)
Tag each file and hunk using path globs and content checks:
- `lockfile`, `generated` (header markers like `@generated`, `.gitattributes`
  `linguist-generated`, known paths such as `dist/` and `*.pb.go`), `snapshot`, `vendor`
- `test`, `docs`, `config`, `ci` (`.github/workflows/**`), `migration`, `deps` (manifest
  changes)
- `rename-only` (100% similarity), `whitespace-only` (empty when diffed with whitespace
  ignored), `comment-only`
- Test↔implementation pairing by name (`foo.ts` ↔ `foo.test.ts`, `x.py` ↔ `test_x.py`)

Lockfiles, generated files, snapshots, vendored code, and rename-only changes skip the LLM
and go straight into a **"Mechanical changes"** group. That saves tokens and noise.

### 4.3 Pre-group (deterministic)
Give the LLM candidate clusters instead of a flat list:
- v1: hunks in the same file next to each other, test files paired with their implementation.
- v2: tree-sitter maps each hunk to its enclosing function or class, and hunks in the same
  symbol get merged (the ClusterChanges rule). Identifier matching adds def-use edges
  (hunk A defines `foo`, hunk B calls `foo`). Union-find over those edges makes the
  clusters.

### 4.4 LLM refine
A single call, whose input is:
- PR title and body (the author's stated intent)
- The hunk list: ID, path, enclosing symbol, tags, and the hunk text (trimmed if huge)
- Candidate clusters from 4.3
- Optional `REVIEW.md` or `.review-dash.yaml` from the repo, with project-specific risk notes

Output, checked against a zod schema:
```json
{
  "summary": "2–4 sentence overview of what the PR does",
  "groups": [
    {
      "title": "Add retry with backoff to webhook sender",
      "intent": "Why this group exists, one sentence",
      "kind": "feature | fix | refactor | test | config | docs | mechanical | other",
      "risk": "high | medium | low",
      "risk_reasons": ["Changes error handling on a network path"],
      "verify": ["Backoff is capped", "Non-retryable 4xx are not retried"],
      "hunk_ids": ["a1b2…", "c3d4…"],
      "depends_on": [1]
    }
  ],
  "unrelated_or_suspicious": ["Optional: changes that don't match the PR's stated intent"]
}
```

**Large PRs.** If the input won't fit the model's budget, map-reduce:
1. Map: summarize each file or cluster in parallel, in one or two sentences plus key symbols.
2. Reduce: group using the summaries and hunk IDs only.
3. Optional: a per-group call that writes the "verify" list using the real hunk text.

### 4.5 Validate (the completeness invariant)
- Every hunk ID appears in **exactly one** group.
- Unknown IDs get dropped. Duplicates are kept in the first group they appear in.
- Missing hunks go into an **"Unclassified — must read"** group, which is always medium
  risk or higher and always shown.
- On a schema failure, retry once with the validation error appended. If that fails too,
  fall back to a deterministic grouping by directory, so the tool always produces
  something.

### 4.6 Risk
Final risk is the higher of the LLM's rating and the rule-based rating:
- Built-in rules: auth/session/crypto paths, `.github/workflows`, migrations, dependency
  manifests, infra (`Dockerfile`, `*.tf`), large deletions, changes to public API exports.
- Per-repo rules: `.review-dash.yaml` in the reviewed repo (globs and regexes mapped to a
  risk level and a reason), the same idea as `REVIEW.md`.
- The low end is Antique-style **auto-clear**: groups that are all mechanical, docs,
  comments, or whitespace start collapsed and pre-marked as reviewed. Start strict and
  loosen later.

### 4.7 Order
- Groups: risk first (high → medium → low → mechanical), then by `depends_on`
  (definitions before the code that uses them).
- Hunks within a group: dependency order where known, otherwise path and line.
- Toggle views in the UI: "By group" (default), "Tests first", and "By file" (the GitHub
  view, as an escape hatch).

### 4.8 Cache
Key: `(repo, pr, headSha, diffHash, provider, model, promptVersion)` → analysis JSON in
SQLite. Re-opening a PR costs nothing. A "Re-analyze" button forces a fresh run.

## 5. LLM providers

A single interface; the analysis code never knows which backend is running:

```ts
interface LlmProvider {
  id: string;                       // "claude-cli" | "codex-cli" | "openrouter"
  complete(req: {
    system: string;
    prompt: string;
    jsonSchema?: object;            // structured output where the backend supports it
    cwd?: string;                   // optional repo checkout for CLI agents to read
    signal?: AbortSignal;
  }): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }>;
}
```

Output is always parsed and checked with zod in our code, whatever the backend claims
about structured output.

### 5.1 Claude subscription: `claude` CLI (headless)
- Spawn the CLI that's already installed and logged in:
  `claude -p --output-format json --model <model>`, with the prompt on stdin.
- It uses my existing Claude Code login, so there's no API key and the cost comes out of
  my plan.
- Optional: `--allowedTools "Read,Grep,Glob"` with `cwd` set to a local checkout, so the
  model can look up code outside the diff when it needs context. Never give it write or
  Bash tools from this tool.
- Parse the JSON envelope and take the `result` field. Check `claude --help` for the
  current flags (structured-output flags change between versions), and feature-detect
  instead of hard-coding them.
- Keep this to personal, local use of my own CLI and check Anthropic's current terms on
  subscription use. Don't embed my OAuth credentials in anything or go around the CLI.

### 5.2 Codex subscription: `codex` CLI (non-interactive)
- Spawn `codex exec` with the prompt on stdin, `--sandbox read-only`, and
  `--output-schema <file>` / `--json` if the installed version supports them
  (feature-detect with `codex exec --help`).
- Uses my ChatGPT/Codex login, so no API key.
- Same optional read-only `cwd` checkout for extra context.

### 5.3 OpenRouter: HTTP
- An OpenAI-compatible endpoint (`https://openrouter.ai/api/v1/chat/completions`) with
  `OPENROUTER_API_KEY` from env or `.env`, never committed.
- `response_format: { type: "json_schema", ... }` for models that support it.
  Otherwise prompt for JSON and validate.
- Lets me try cheap or fast models for the map step and stronger ones for the reduce step.
- Show the cost from the response's usage data in the UI.

### 5.4 Configuration
`~/.config/review-dash/config.json`, outside the repo:
```json
{
  "provider": "claude-cli",
  "models": { "claude-cli": "sonnet", "codex-cli": "gpt-5-codex", "openrouter": "anthropic/claude-sonnet-4.5" },
  "mapProvider": "openrouter",
  "maxConcurrency": 4
}
```
Model names above are examples. Override per run with `--provider` / `--model`, or with
the switcher in the UI.

### 5.5 Later: direct API keys
Anthropic and OpenAI SDK adapters would be about 30 lines each behind the same
interface. Not needed for the MVP.

## 6. UI

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ owner/repo #123  "Add webhook retries"  ·  +1,840 −312  ·  head a1b2c3  ·  [Re-analyze]│
│ Summary: …                                                     [Submit review ▾] (3) │
├───────────────────────────┬──────────────────────────────────────────────────────────┤
│ ● HIGH  Retry/backoff  2/5│  Retry/backoff in webhook sender            HIGH         │
│ ● HIGH  DB migration   0/2│  Intent: …                                               │
│ ● MED   Config plumbing   │  Why risky: changes error handling on network path       │
│ ● LOW   Tests        ✓    │  Verify: ☐ backoff capped  ☐ 4xx not retried             │
│ ○ AUTO  Mechanical (14) ✓ │  ──────────────────────────────────────────────────────  │
│ ○ !!    Unclassified (1)  │  src/webhooks/send.ts  ☐ reviewed                        │
│                           │   @@ -40,6 +40,22 @@ async function send(...)            │
│ Progress ███████░░ 64%    │   + for (let attempt = 0; ...           [💬 comment]     │
└───────────────────────────┴──────────────────────────────────────────────────────────┘
```

- **Left rail:** groups in risk order, a risk badge, per-group progress (reviewed hunks out
  of total), and an overall progress bar.
- **Group card:** title, intent, risk reasons, a "verify" checklist (local only), and the
  group's hunks with file headers.
- **Diff:** unified by default, split view toggle, syntax highlighting, "expand context"
  above and below each hunk (from file contents), and a "hide whitespace" toggle.
- **Comments:** click a line number or drag across several to open a composer. Drafts save
  locally as I type. Existing GitHub threads show inline (resolved ones collapsed).
- **Submit:** a modal showing every draft, a body field, and Comment / Approve / Request
  changes.
- **Keyboard:** `j/k` next/prev hunk, `J/K` next/prev group, `r` mark reviewed, `c`
  comment, `?` help.
- **Ask:** a per-group "Explain this" button that sends the group's hunks (plus optional
  repo context) to the provider and streams back an explanation. Nice to have.
- **Re-review after a push:** a banner reading "3 new commits since you last reviewed".
  Hunks whose ID is already marked reviewed are hidden by default, so only new or changed
  hunks show. GitHub's compare API (`base...head` between the two head SHAs) lists the
  files touched.

## 7. Local server and security

- Bind to `127.0.0.1` only, on a random free port. The CLI opens the browser.
- The server can post to GitHub as me, so other local web pages must not be able to drive
  it:
  - Generate a random session token per run and pass it in the URL fragment. The UI sends
    it as a header, and the server rejects requests without it.
  - Check the `Host`/`Origin` headers to block DNS rebinding.
- Never send the GitHub token or provider keys to the browser.
- Logs leave out tokens and don't include full prompts unless `--debug` is set.

## 8. Data model (SQLite)

```
analyses(id, repo, pr, head_sha, diff_hash, provider, model, prompt_version, json, created_at)
drafts(id, repo, pr, path, side, line, start_line, start_side, body, hunk_id, head_sha, updated_at)
reviewed_hunks(repo, pr, hunk_id, reviewed_at, head_sha)        -- survives new pushes
verify_checks(repo, pr, group_key, item_index, checked)
reviews_submitted(id, repo, pr, head_sha, github_review_id, event, submitted_at)
```

## 9. Repo layout

```
review-dash/
  docs/PLAN.md
  .env.example              # placeholders only
  src/
    cli/index.ts            # arg parsing, starts server, opens browser
    server/                 # Hono routes: /api/pr, /api/analysis, /api/drafts, /api/review
    core/
      github/               # octokit client, fetch PR/files/threads, submit review
      diff/                 # patch parsing, hunk IDs, line mapping for comments
      classify/             # path/content rules, mechanical detection
      group/                # pre-grouping, LLM prompt, validator, ordering
      risk/                 # built-in + .review-dash.yaml rules
      llm/                  # provider interface + claude-cli, codex-cli, openrouter
      store/                # sqlite schema + queries
    web/                    # React app
  test/fixtures/            # saved PR payloads for offline tests (public repos only)
```

## 10. Milestones

Each milestone ends with something I can use.

**M0: Scaffold (½ day)**
- TS project, lint/format, vitest, Vite and React, Hono, CLI entry, `.env.example`.
- `review-dash owner/repo#123` starts the server and opens the browser.

**M1: Better GitHub diff viewer, no LLM yet (1–2 days)**
- Fetch the PR, files, and patches. Parse into hunks with stable IDs.
- Render all files with `react-diff-view`, highlighting, and context expansion.
- Draft comments (single and multi-line) saved in SQLite, submitted as one review. Out-of-hunk
  comments fall back to the review body.
- Existing review threads shown inline.
- *Exit check:* I can fully review a real PR here and the comments show up correctly on
  GitHub.

**M2: Grouping with an LLM (2–3 days)**
- Provider interface, plus the OpenRouter adapter first (easiest to debug), then claude-cli,
  then codex-cli.
- Classification, mechanical group, LLM grouping, validator with back-fill, risk-first
  ordering, cache.
- Grouped UI: left rail, group card, verify list.
- *Exit check:* on 3 of my real PRs the groups are coherent and no hunk goes missing.

**M3: Review state and re-review (1–2 days)**
- Reviewed checkboxes per hunk, progress bars, auto-cleared mechanical groups.
- Interdiff after new pushes, and draft re-anchoring or outdated warnings.
- `.review-dash.yaml` risk rules.

**M4: Quality (ongoing)**
- tree-sitter symbol mapping and def-use pre-grouping.
- Move/copy detection (`git diff --color-moved` on a local checkout, or matching
  identical removed/added blocks).
- Map-reduce for very large PRs. Use a cheap model for the map step.
- "Explain this group" chat. Keyboard shortcuts.
- An optional local checkout (`--repo-path`, or a shallow clone into `~/.review-dash/repos`)
  so CLI agents can read context outside the diff.

**Later / maybe**
- Show `/code-review` or CI findings on the groups they touch.
- Export the review as a Markdown or JSON fix list for an agent, or run a small MCP server
  with `get_review_comments`.
- Stacked PR awareness (diff each PR against the one below it).
- Plan-drift check against a linked spec or issue.

## 11. Testing and evaluation

- **Unit:** patch parsing (renames, binary files, no-newline-at-EOF, huge files with no
  patch), hunk ID stability, comment line/side mapping, the validator's completeness
  guarantee, risk rule matching.
- **Fixtures:** saved API responses from a few *public* PRs, so tests run offline and
  without tokens.
- **Provider contract tests:** a fake provider that returns broken, partial, and duplicate
  JSON, to exercise retry and back-fill.
- **Grouping eval (manual at first):** a `pnpm eval` script runs grouping on about 5 saved
  PRs and prints group count, hunks per group, number of back-filled hunks, tokens and
  cost, and time. Compare providers and models side by side, then judge by eye whether the
  groups make sense.

## 12. Open questions
- Should I clone the repo locally by default? It gives better context (tree-sitter,
  move detection, agent reads) but adds disk use and setup. Current plan: optional in M4.
- Do auto-cleared groups count as reviewed when I submit an Approve? Start with "no":
  they're pre-checked, but I can see they were auto-cleared.
- Do I want comment suggestions (` ```suggestion ` blocks) in the composer? It's cheap
  to add, since GitHub renders them.

## 13. Secrets checklist (public repo)
- `.env` and `.env.*` are gitignored. Only `.env.example` with empty placeholders is
  committed.
- Config, database, cached analyses, and clones all live under `~/.review-dash` or
  `~/.config/review-dash`, never in the working tree.
- Test fixtures come from public PRs only, with auth headers stripped before saving.
- Consider adding a pre-commit secret scan (e.g. `gitleaks`) in M0.
