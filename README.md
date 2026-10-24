# review-dash

A local dashboard for reviewing GitHub pull requests. Run it against a PR and it starts a
server on `127.0.0.1` and opens a review UI in your browser. See [docs/PLAN.md](docs/PLAN.md)
for the design and milestones.

Status: M0 scaffold. The UI currently shows only the PR reference being reviewed.

## Setup

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm build
```

## Usage

```sh
pnpm start owner/repo#123
pnpm start https://github.com/owner/repo/pull/123 --port 8080 --no-open
```

By default the browser is opened for you. With `--no-open` the full URL is printed. It
contains a session token (`#token=...`), so don't share or log it. When the browser is
opened automatically, the printed URL is redacted.

Flags: `--provider`, `--model`, `--port`, `--no-open`, `--debug`.

After `pnpm link --global`, run it as `review-dash owner/repo#123`.

Views (header): **By group** (default once the analysis finishes: groups in risk order, with
intent, risk reasons and a verify checklist), **Tests first**, and **By file** (the plain diff).
Each hunk has a reviewed checkbox, and the rail shows per-group and overall progress. Mechanical
groups are auto-cleared: pre-checked and marked "auto-cleared", but not counted as your review.
After new commits are pushed, a banner lists them and "Hide reviewed hunks" leaves only new or
changed hunks. Drafts that no longer fit the new diff are marked outdated and go in the review
body.

Shortcuts: `j`/`k` next/previous hunk, `J`/`K` next/previous group, `r` toggle reviewed, `c`
comment on the focused hunk, `?` help, `Esc` close dialogs.

Per-repo risk rules go in `.review-dash.yaml` at the repo root (see
`docs/review-dash.example.yaml`). Providers and models are set with `--provider`/`--model`, the
header switcher, or the config file (see `docs/PLAN.md` section 5.4).

To try the UI without a token, run `pnpm build && pnpm demo` (add `DEMO_REREVIEW=1` for the
re-review banner).

## Authentication

The GitHub token is resolved in this order:

1. `gh auth token` (the GitHub CLI)
2. the `GITHUB_TOKEN` environment variable

Copy `.env.example` to `.env` for local environment variables (`GITHUB_TOKEN`,
`OPENROUTER_API_KEY`). `.env` is gitignored; never commit secrets. Tokens are never sent to
the browser.

## Development

```sh
PR=owner/repo#123 pnpm dev   # rebuilds the UI on change, restarts the server on port 5174
pnpm lint
pnpm typecheck
pnpm test
pnpm format
```

Data lives in `~/.review-dash` (override with `REVIEW_DASH_HOME`) and config in
`~/.config/review-dash` (respects `XDG_CONFIG_HOME`).

## Layout

`src/cli` (entry point), `src/server` (Hono API, serves the built UI), `src/core`
(domain logic), `src/web` (React + Tailwind UI).
