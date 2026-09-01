/**
 * Which commits a rebase would really replay, read off the loaded commits.
 *
 * The rebase dialog lists these and lets each one be unticked, so this list is
 * the whole of what the user is told will move — they are not asked to work out
 * a half-open range from a gesture. That puts two obligations on it:
 *
 * - **Merge commits are not in it.** A rebase without `--rebase-merges` never
 *   replays them; it flattens the diamond, copies the side branch's commits and
 *   leaves the side branch's labels on the originals. Listing a merge would
 *   promise a move git will not make, so it is counted and described instead.
 * - **A range it cannot see the end of says so.** The webview only holds a
 *   window of history, and a range whose lower bound is off the bottom of that
 *   window would otherwise come back looking short — an under-long list is the
 *   dangerous direction, because the dialog's ticks would silently drop commits
 *   the user was never shown.
 */

import type { GitCommitNode } from "@/backend/types";

import { commitsReachableFrom } from "./utils/git";

/** One row of the list: what the dialog shows, and what the todo needs. */
export interface RebaseReplayCommit {
  hash: string;
  message: string;
}

export interface RebaseReplay {
  /** The commits git would replay, **oldest first** — git's own todo order,
   *  which is the order `planRebase` reads. Empty is a real answer: a rebase
   *  with nothing to replay is a fast-forward, which git still performs. */
  commits: RebaseReplayCommit[];
  /** Merge commits inside the range that git will flatten rather than replay. */
  mergesSquashed: number;
  /** Local branches sitting on commits inside the range other than its tip.
   *  Each keeps pointing at the original commit while a copy of it lands on the
   *  new base — the duplicate a flattened merge leaves behind. */
  strandedBranches: string[];
  /** The range reaches commits the webview has not loaded, so the list above is
   *  the part of it that could be seen and may be short. */
  incomplete: boolean;
}

/** The commits in `upstream..tip` — after `upstream`, up to and including
 *  `tip` — as the dialog lists them. Ancestry decides membership, never the
 *  graph's row order; the row order only decides how the members are sorted. */
export function rebaseReplay(
  upstream: string,
  tip: string,
  commits: readonly GitCommitNode[],
  commitLookup: { [hash: string]: number }
): RebaseReplay {
  const nodeOf = (hash: string): GitCommitNode | undefined => {
    const index = commitLookup[hash];
    return index === undefined ? undefined : commits[index];
  };
  const excluded = commitsReachableFrom([upstream], (hash) => nodeOf(hash)?.parentHashes);

  // Walk back from the tip, stopping wherever the lower bound already reaches.
  // A commit that is named as a parent but was never loaded is where the window
  // ends, and the range beyond it is unknown rather than empty.
  const inRange = new Set<string>();
  const beyondTheWindow = new Set<string>();
  const pending = [tip];
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (excluded.has(hash) || inRange.has(hash)) continue;
    const node = nodeOf(hash);
    if (node === undefined) {
      beyondTheWindow.add(hash);
      continue;
    }
    inRange.add(hash);
    for (const parent of node.parentHashes) pending.push(parent);
  }

  // Graph order (newest first) for everything derived below, so the dialog's
  // rows and the graph's rows agree; the replay list is reversed at the end
  // into the order git replays them in.
  const members = commits.filter((commit) => inRange.has(commit.hash));
  const replayed = members.filter((commit) => commit.parentHashes.length <= 1);
  return {
    commits: replayed
      .map((commit) => ({ hash: commit.hash, message: commit.message }))
      .toReversed(),
    mergesSquashed: members.length - replayed.length,
    strandedBranches: members
      // The tip's own branch is the one git moves, so it is the one label that
      // does not stay behind.
      .filter((commit) => commit.hash !== tip)
      .flatMap((commit) => commit.refs.filter((r) => r.type === "head").map((r) => r.name)),
    incomplete: beyondTheWindow.size > 0
  };
}
