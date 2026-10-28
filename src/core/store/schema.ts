/** Ordered migrations; `PRAGMA user_version` records how many have been applied. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE analyses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    repo           TEXT NOT NULL,
    pr             INTEGER NOT NULL,
    head_sha       TEXT NOT NULL,
    diff_hash      TEXT NOT NULL,
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    json           TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (repo, pr, head_sha, diff_hash, provider, model, prompt_version)
  );

  CREATE TABLE drafts (
    id         TEXT PRIMARY KEY,
    repo       TEXT NOT NULL,
    pr         INTEGER NOT NULL,
    path       TEXT NOT NULL,
    side       TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
    line       INTEGER NOT NULL,
    start_line INTEGER,
    start_side TEXT CHECK (start_side IN ('LEFT', 'RIGHT')),
    body       TEXT NOT NULL,
    hunk_id    TEXT,
    head_sha   TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX drafts_by_pr ON drafts (repo, pr);

  CREATE TABLE reviewed_hunks (
    repo        TEXT NOT NULL,
    pr          INTEGER NOT NULL,
    hunk_id     TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    head_sha    TEXT NOT NULL,
    PRIMARY KEY (repo, pr, hunk_id)
  );

  CREATE TABLE verify_checks (
    repo        TEXT NOT NULL,
    pr          INTEGER NOT NULL,
    group_key   TEXT NOT NULL,
    item_index  INTEGER NOT NULL,
    checked     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, pr, group_key, item_index)
  );

  CREATE TABLE reviews_submitted (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    repo             TEXT NOT NULL,
    pr               INTEGER NOT NULL,
    head_sha         TEXT NOT NULL,
    github_review_id INTEGER,
    event            TEXT NOT NULL,
    submitted_at     TEXT NOT NULL
  );
  `,
  // Monotonic per-draft counter: updated_at is millisecond-resolution, so two saves can tie.
  `ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;`,
  // M3: re-anchoring. `outdated` drafts no longer map onto the diff; the anchor records
  // where the commented line sat inside its hunk (index into hunk.lines) and its text.
  `
  ALTER TABLE drafts ADD COLUMN outdated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE drafts ADD COLUMN anchor_index INTEGER;
  ALTER TABLE drafts ADD COLUMN anchor_start_index INTEGER;
  ALTER TABLE drafts ADD COLUMN anchor_text TEXT;
  `,
  // Re-review baseline: "Done reviewing these changes" records the head the reviewer is caught up to.
  `
  CREATE TABLE review_checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo       TEXT NOT NULL,
    pr         INTEGER NOT NULL,
    head_sha   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX review_checkpoints_by_pr ON review_checkpoints (repo, pr);
  `,
];
