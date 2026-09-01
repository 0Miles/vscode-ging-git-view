/**
 * Which git command a rebase should actually be, given which of its commits the
 * user left ticked in the dialog.
 *
 * The dialog lists the commits a rebase would replay and lets any of them be
 * unticked. Most of the time nothing is unticked, and then the rebase must stay
 * the plain command it has always been — an untouched dialog may not change
 * what runs. Dropping only the oldest commits is still expressible as a range,
 * so it stays a plain rebase with the lower bound moved forward. Only a gap in
 * the middle, or dropping the newest commits, needs the interactive form: those
 * are the shapes a single range cannot spell.
 *
 * Dropping the newest commits is the case that is easy to get wrong. It looks
 * like "just move the upper bound back", but `git rebase --onto X A B` checks
 * out B detached — so the branch would stay where it was and the replayed
 * commits would be a second copy. The interactive form keeps git's `head-name`,
 * and with it the branch move.
 */

/** A commit the rebase would replay, and whether the user kept it ticked. */
export type RebaseCommit = {
  hash: string;
  /** The commit's subject. Only ever written into the todo as a comment to the
   *  right of the hash, where git ignores it — it is there for the human who
   *  ends up looking at the file mid-conflict. */
  message: string;
  keep: boolean;
  /** The commit's parents. Read for one question only — whether the list is a
   *  single chain — because the answer decides whether a range may stand in for
   *  it (see {@link listIsChain}). Carried per commit rather than asserted once
   *  by the caller so the plan derives the fact instead of trusting it. */
  parentHashes: readonly string[];
};

export type RebasePlan =
  /** Nothing left to replay — the caller reports this rather than running git. */
  | { kind: "empty" }
  /** Every commit kept: run whatever command this rebase was already going to
   *  run, untouched. */
  | { kind: "unchanged" }
  /** Only the oldest commits were dropped, so the range still describes it —
   *  same command, with `upstream` moved forward to the last dropped commit. */
  | { kind: "narrowed"; upstream: string }
  /** A gap in the middle, or the newest commits dropped: an interactive rebase
   *  whose todo we write ourselves. */
  | { kind: "interactive"; todo: string };

/**
 * Decide the shape of the rebase.
 *
 * `commits` is the replay list, **oldest first** — the same order git's todo
 * uses, and the same order the dialog shows. Merge commits must not be in it: a
 * rebase without `--rebase-merges` never replays them, so listing one would
 * promise something git will not do.
 *
 * Dropping the merges is what makes {@link listIsChain} necessary. The list is
 * then the merge's two sides laid end to end, and the `narrowed` shortcut —
 * "name the last dropped commit as the new lower bound" — is only the same set
 * as "drop this prefix" when there is one strand to walk back along.
 */
export function planRebase(commits: readonly RebaseCommit[]): RebasePlan {
  // `every` is true of an empty list, so this is also the "nothing to replay" case.
  if (commits.every((commit) => !commit.keep)) return { kind: "empty" };
  if (commits.every((commit) => commit.keep)) return { kind: "unchanged" };

  // Kept commits form a suffix (they run to the newest with no gap) exactly when
  // nothing after the first kept one was dropped.
  const firstKept = commits.findIndex((commit) => commit.keep);
  if (commits.slice(firstKept).every((commit) => commit.keep) && listIsChain(commits)) {
    // The last dropped commit becomes the new exclusive lower bound.
    return { kind: "narrowed", upstream: commits[firstKept - 1].hash };
  }
  return { kind: "interactive", todo: rebaseTodo(commits) };
}

/**
 * Whether the list is a single chain — every commit the child of the one before
 * it.
 *
 * This is the precondition on `narrowed`, and the reason it exists is the merge
 * commits that are *not* on the list. `git rebase --onto X <bound> <tip>`
 * excludes `<bound>` **and everything `<bound>` can reach**, which equals "the
 * commits listed before it" only on one strand. Where a merge was flattened
 * away the list holds both of its sides: name a side-branch commit as the bound
 * and the mainline commits beside it are not its ancestors, so git replays them
 * — commits the user had unticked, dropped from the list's promise without a
 * word. A list that is not a chain therefore falls through to the interactive
 * form, which spells every commit out as `pick` or `drop` and cannot be read
 * two ways.
 */
function listIsChain(commits: readonly RebaseCommit[]): boolean {
  return commits.every((commit, i) => i === 0 || commit.parentHashes.includes(commits[i - 1].hash));
}

/**
 * git's todo for the replay list: one line per commit, oldest first, `drop` for
 * the ones that were unticked.
 *
 * The dropped commits are spelled out rather than omitted. git checks the todo
 * against the commits it expected (`rebase.missingCommitsCheck`), and a line it
 * can see is a line it will not complain about — an omitted one leaves the
 * outcome depending on a setting we do not control.
 *
 * Takes less than a whole {@link RebaseCommit} because it needs less: a todo
 * names every commit explicitly, so ancestry has nothing to decide here. That
 * is the same reason it is always safe where `narrowed` is not.
 */
export function rebaseTodo(
  commits: readonly Pick<RebaseCommit, "hash" | "message" | "keep">[]
): string {
  return (
    commits
      .map(
        (commit) =>
          `${commit.keep ? "pick" : "drop"} ${commit.hash} ${commit.message.replace(/[\r\n]+/g, " ")}`
      )
      .join("\n") + "\n"
  );
}
