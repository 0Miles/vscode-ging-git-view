import type { BlamedCommit, CommitChange } from "@/backend/queries/blameCommitChange";

/**
 * Each commit's change to a file, as `load` finds it in a repository, loaded
 * once and kept — a commit never changes, so a change is only ever dropped to
 * make room, the least recently used first, `size` at most. A failure (null,
 * or a rejection) is not kept: it may not happen again, so the next request
 * loads again.
 *
 * Only the latest request loads: at most one load is in flight, and asking for
 * any other change — or `cancel` — aborts it through its signal, so its git
 * processes are killed rather than left to run to their deadline. An aborted
 * load is not kept either.
 */
export function createBlameChanges(deps: {
  load: (commit: BlamedCommit, repo: string, signal: AbortSignal) => Promise<CommitChange | null>;
  size: number;
}): {
  changeOf: (commit: BlamedCommit, repo: string) => Promise<CommitChange | null>;
  cancel: () => void;
} {
  const entries = new Map<string, Promise<CommitChange | null>>();
  let inFlight: { key: string; abort: AbortController } | undefined;

  function cancel() {
    if (inFlight === undefined) return;
    inFlight.abort.abort();
    // Gone at once, so nothing asked for meanwhile gets its null.
    entries.delete(inFlight.key);
    inFlight = undefined;
  }

  function changeOf(commit: BlamedCommit, repo: string): Promise<CommitChange | null> {
    const key = JSON.stringify([
      repo,
      commit.sha,
      commit.filename,
      commit.previous?.sha,
      commit.previous?.filename
    ]);
    if (inFlight?.key !== key) cancel();
    const cached = entries.get(key);
    if (cached !== undefined) {
      // Most recently used goes last, so the first is the one to drop.
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const abort = new AbortController();
    const flight = { key, abort };
    inFlight = flight;
    const change: Promise<CommitChange | null> = deps
      .load(commit, repo, abort.signal)
      .catch(() => null)
      .then((result) => {
        if (inFlight === flight) inFlight = undefined;
        // Only this load's own entry: a newer one may have taken its key.
        if (result === null && entries.get(key) === change) entries.delete(key);
        return result;
      });
    entries.set(key, change);
    if (entries.size > deps.size) entries.delete(entries.keys().next().value!);
    return change;
  }

  return { changeOf, cancel };
}
