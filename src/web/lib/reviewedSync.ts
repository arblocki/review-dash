export interface ReviewedSyncDeps {
  /** Called with the new reviewed set after every optimistic change, rollback or snapshot. */
  onChange(next: ReadonlySet<string>): void;
  /** A save failed (called whether or not anything was rolled back). */
  onError(err: unknown): void;
}

export interface ReviewedSync {
  /** The current optimistic reviewed set. */
  current(): ReadonlySet<string>;
  /**
   * Marks or unmarks items now and saves with `send`. Requests run one at a time in call order,
   * so the server ends in the state of the last call. If a save fails, each item goes back to
   * its last server-confirmed value unless a newer change to that item has been made since.
   */
  setItems(ids: readonly string[], reviewed: boolean, send: () => Promise<unknown>): Promise<void>;
  /** Applies the server's reviewed ids (the initial load) alongside local changes. */
  applySnapshot(serverIds: Iterable<string>): void;
}

/** Framework-free optimistic sync of the reviewed set with `PUT /api/reviewed`. */
export function createReviewedSync(deps: ReviewedSyncDeps): ReviewedSync {
  let state: ReadonlySet<string> = new Set();
  // Bumped on every change to an item; a failed save only rolls back items still at its value.
  const generation = new Map<string, number>();
  // What the server is known to hold per item: its value before our first change, then the
  // value of the last save that succeeded.
  const confirmed = new Map<string, boolean>();
  let queue: Promise<void> = Promise.resolve();

  const publish = (next: ReadonlySet<string>) => {
    state = next;
    deps.onChange(next);
  };

  return {
    current: () => state,
    applySnapshot(serverIds) {
      const ids = [...serverIds];
      for (const id of ids) if (!confirmed.has(id)) confirmed.set(id, true);
      publish(new Set([...ids, ...state]));
    },
    setItems(ids, reviewed, send) {
      const next = new Set(state);
      const mine = new Map<string, number>();
      for (const id of ids) {
        if (!confirmed.has(id)) confirmed.set(id, state.has(id));
        const gen = (generation.get(id) ?? 0) + 1;
        generation.set(id, gen);
        mine.set(id, gen);
        if (reviewed) next.add(id);
        else next.delete(id);
      }
      publish(next);

      const run = queue.then(send).then(
        () => {
          for (const id of ids) confirmed.set(id, reviewed);
        },
        (err: unknown) => {
          const rolled = new Set(state);
          for (const [id, gen] of mine) {
            if (generation.get(id) !== gen) continue;
            if (confirmed.get(id)) rolled.add(id);
            else rolled.delete(id);
          }
          publish(rolled);
          deps.onError(err);
        },
      );
      queue = run;
      return run;
    },
  };
}
