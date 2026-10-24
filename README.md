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

Flags: `--provider`, `--model`, `--port`, `--no-open`, `--debug`.

After `pnpm link --global`, run it as `review-dash owner/repo#123`.

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
