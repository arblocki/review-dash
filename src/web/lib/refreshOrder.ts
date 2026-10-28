export interface RefreshSteps<D> {
  /** Re-fetches the PR from GitHub (`/api/pr?refresh=1`); the server adopts the new head here. */
  fetchPr(): Promise<D>;
  loadThreads(): Promise<unknown>;
  loadDrafts(): Promise<unknown>;
}

/**
 * Drafts are re-anchored by the server against whatever head it has when asked, so they are
 * read only after the PR refresh has finished. Threads do not depend on it and run alongside.
 */
export async function refreshInOrder<D>(steps: RefreshSteps<D>): Promise<D> {
  const threads = steps.loadThreads();
  let data: D;
  try {
    data = await steps.fetchPr();
  } catch (err) {
    await threads.catch(() => undefined);
    throw err;
  }
  await Promise.all([threads, steps.loadDrafts()]);
  return data;
}
