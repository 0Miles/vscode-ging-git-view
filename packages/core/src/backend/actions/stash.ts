import type { SimpleGit } from "simple-git";

import type { ActionPayload, StashRefusalFacts } from "@ging/shared/backend/types";

/** A stash action refused before any stash command ran: its selector resolves
 *  to another commit than `expectedHash`, or to nothing. Why — see
 *  `StashTarget`. */
export class StashMovedError extends Error {
  constructor(
    readonly selector: string,
    readonly expectedHash: string,
    /** What `selector` resolved to instead, or null when it resolved to
     *  nothing — the stack is shorter than it was. */
    readonly actualHash: string | null
  ) {
    super(
      `${selector} no longer refers to stash ${expectedHash}` +
        (actualHash === null ? " (it no longer exists)" : ` (it is now ${actualHash})`)
    );
    this.name = "StashMovedError";
  }
}

/** What a stash action reports beside its status, read off the error it threw
 *  (null when it succeeded). */
export function stashRefusalFacts(error: unknown): StashRefusalFacts {
  return { movedSelector: error instanceof StashMovedError ? error.selector : null };
}

/**
 * Refuse with `StashMovedError` unless `selector` still resolves to
 * `expectedHash`; return that SHA when it does.
 *
 * This narrows the window `StashTarget` describes, it does not close it. The
 * `rev-parse` here and the stash command after it are two spawns, and git has
 * no compare-and-swap for stash entries — `stash drop` takes only a
 * `stash@{n}`, never a SHA — so a push landing between the two still
 * renumbers the stack under the second one. What is gone is the long window:
 * from the moment the caller read the selector to the moment the action
 * reached the host.
 */
async function verifyStashSelector(
  git: SimpleGit,
  selector: string,
  expectedHash: string
): Promise<string> {
  // `--verify --quiet`: a selector that names nothing — past the end of the
  // stack — exits 1 with no output, which simple-git resolves as "". Any other
  // failure (not a repository, git missing) rejects, and is git's to report.
  const actualHash = (await git.raw(["rev-parse", "--verify", "--quiet", selector])).trim() || null;
  if (actualHash !== expectedHash) {
    throw new StashMovedError(selector, expectedHash, actualHash);
  }
  return expectedHash;
}

/** Apply a stash to the working tree, keeping it in the stash list. With
 *  `reinstateIndex`, the stash's staged changes are restored to the index too. */
export async function applyStash(
  git: SimpleGit,
  input: ActionPayload<"applyStash">
): Promise<void> {
  await verifyStashSelector(git, input.selector, input.expectedHash);
  const args = ["stash", "apply"];
  if (input.reinstateIndex) args.push("--index");
  args.push(input.selector);
  await git.raw(args);
}

/** Apply a stash and drop it from the stash list on success. */
export async function popStash(git: SimpleGit, input: ActionPayload<"popStash">): Promise<void> {
  await verifyStashSelector(git, input.selector, input.expectedHash);
  const args = ["stash", "pop"];
  if (input.reinstateIndex) args.push("--index");
  args.push(input.selector);
  await git.raw(args);
}

/** Delete a stash from the stash list. */
export async function dropStash(git: SimpleGit, input: ActionPayload<"dropStash">): Promise<void> {
  await verifyStashSelector(git, input.selector, input.expectedHash);
  await git.raw(["stash", "drop", input.selector]);
}

/** Rename a stash. Git has no native rename, and `git stash store -m` only sets
 *  the reflog message (`%gs`) while the stash's *displayed* message is its commit
 *  subject (`%s`). So we rebuild the stash commit with the new subject — same
 *  tree and parents (base/index/untracked), new message — via `commit-tree`,
 *  then drop the old entry and store the rebuilt commit.
 *
 *  The replacement commit is built BEFORE the drop, so a failure can't lose the
 *  stash. Caveat: `stash store` pushes onto the top of the stack, so a renamed
 *  stash moves to `stash@{0}`. */
export async function renameStash(
  git: SimpleGit,
  input: ActionPayload<"renameStash">
): Promise<void> {
  // A wider window than apply/pop/drop: three more spawns sit between this and the drop.
  const sha = await verifyStashSelector(git, input.selector, input.expectedHash);
  const tree = (await git.raw(["rev-parse", `${sha}^{tree}`])).trim();
  // `rev-list --parents -n 1 <sha>` → "<sha> <parent>...": drop the commit's
  // own sha, keep its parents (a stash has base + index [+ untracked]).
  const revList = (await git.raw(["rev-list", "--parents", "-n", "1", sha])).trim();
  const parentArgs = revList
    .split(/\s+/)
    .slice(1)
    .flatMap((parent) => ["-p", parent]);
  const newCommit = (
    await git.raw(["commit-tree", tree, ...parentArgs, "-m", input.message])
  ).trim();
  await git.raw(["stash", "drop", input.selector]);
  try {
    await git.raw(["stash", "store", "-m", input.message, newCommit]);
  } catch (e: unknown) {
    // The drop succeeded but the re-store didn't: the stash is gone from the
    // list yet the rebuilt commit is reachable. Tell the user how to recover it.
    throw new Error(`stash store failed after drop; recover with: git stash store ${newCommit}`, {
      cause: e
    });
  }
}
