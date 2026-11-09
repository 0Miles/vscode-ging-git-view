import type { CommitChange } from "@/backend/queries/blameCommitChange";
import type { BlameLine } from "@/backend/queries/blameFile";

/** Which change of which commit: a blamed line's commit, and the file there. */
export type BlamedCommit = Pick<BlameLine, "sha" | "filename" | "previous">;

/**
 * Each commit's change to a file, as `load` finds it in a repository, loaded
 * once and kept — a commit never changes, so a change is only ever dropped to
 * make room, the least recently used first, `size` at most. A failure (null,
 * or a rejection) is not kept: it may not happen again, so the next call loads
 * again.
 */
export function createBlameChanges(deps: {
  load: (commit: BlamedCommit, repo: string) => Promise<CommitChange | null>;
  size: number;
}): (commit: BlamedCommit, repo: string) => Promise<CommitChange | null> {
  const entries = new Map<string, Promise<CommitChange | null>>();
  return (commit, repo) => {
    const key = JSON.stringify([
      repo,
      commit.sha,
      commit.filename,
      commit.previous?.sha,
      commit.previous?.filename
    ]);
    const cached = entries.get(key);
    if (cached !== undefined) {
      // Most recently used goes last, so the first is the one to drop.
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const change: Promise<CommitChange | null> = deps
      .load(commit, repo)
      .catch(() => null)
      .then((result) => {
        // Only this load's own entry: a newer one may have taken its key.
        if (result === null && entries.get(key) === change) entries.delete(key);
        return result;
      });
    entries.set(key, change);
    if (entries.size > deps.size) entries.delete(entries.keys().next().value!);
    return change;
  };
}
