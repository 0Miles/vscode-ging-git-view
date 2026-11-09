import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

/** Apply a stash to the working tree, keeping it in the stash list. With
 *  `reinstateIndex`, the stash's staged changes are restored to the index too. */
export async function applyStash(
  git: SimpleGit,
  input: ActionPayload<"applyStash">
): Promise<void> {
  const args = ["stash", "apply"];
  if (input.reinstateIndex) args.push("--index");
  args.push(input.selector);
  await git.raw(args);
}

/** Apply a stash and drop it from the stash list on success. */
export async function popStash(git: SimpleGit, input: ActionPayload<"popStash">): Promise<void> {
  const args = ["stash", "pop"];
  if (input.reinstateIndex) args.push("--index");
  args.push(input.selector);
  await git.raw(args);
}

/** Delete a stash from the stash list. */
export async function dropStash(git: SimpleGit, input: ActionPayload<"dropStash">): Promise<void> {
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
  const sha = (await git.raw(["rev-parse", input.selector])).trim();
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
