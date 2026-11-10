import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@ging/shared/backend/types";

/**
 * A stash action refused because its selector no longer names the stash the
 * request was about: `selector` resolves to another commit than
 * `expectedHash`, or to nothing at all. Thrown before any stash command is
 * spawned, so the stack is exactly as it was.
 *
 * `stash@{n}` is a position, and every `git stash push` — the terminal, the
 * SCM view, a `pull --autostash` — renumbers everything below the top. The
 * graph already refuses this at consent (`forStash` in the webview); this is
 * the host's half of the same rule, for the time between the request leaving
 * the caller and git running, and for callers with no loaded graph to check
 * against. Refused, not redirected to wherever `expectedHash` sits now: the
 * selector is what the user was shown and agreed to.
 */
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

/** The selector a refused stash action could not act through — see
 *  `StashMovedError` — or null when `error` is anything else (or nothing).
 *  What a stash action reports beside its status. */
export function stashRefusalFacts(error: unknown): { movedSelector: string | null } {
  return { movedSelector: error instanceof StashMovedError ? error.selector : null };
}

/**
 * Resolve `selector` and return its commit SHA, refusing with
 * `StashMovedError` unless it is `expectedHash`.
 *
 * This narrows the window, it does not close it. The `rev-parse` here and the
 * `git stash apply/pop/drop` after it are two spawns, and git has no
 * compare-and-swap for stash entries — `stash drop` takes only a `stash@{n}`,
 * never a SHA — so a push landing between the two still renumbers the stack
 * under the second one. What is gone is the long window: from the moment the
 * caller read the selector to the moment the action reached the host.
 */
async function resolveStash(
  git: SimpleGit,
  selector: string,
  expectedHash: string
): Promise<string> {
  let actualHash: string | null;
  try {
    // `--verify --quiet`: a selector past the end of the stack prints nothing
    // and fails, rather than echoing the argument back.
    const out = (await git.raw(["rev-parse", "--verify", "--quiet", selector])).trim();
    actualHash = out === "" ? null : out;
  } catch {
    actualHash = null;
  }
  if (actualHash !== expectedHash) {
    throw new StashMovedError(selector, expectedHash, actualHash);
  }
  return actualHash;
}

/** Apply a stash to the working tree, keeping it in the stash list. With
 *  `reinstateIndex`, the stash's staged changes are restored to the index too. */
export async function applyStash(
  git: SimpleGit,
  input: ActionPayload<"applyStash">
): Promise<void> {
  await resolveStash(git, input.selector, input.expectedHash);
  const args = ["stash", "apply"];
  if (input.reinstateIndex) args.push("--index");
  args.push(input.selector);
  await git.raw(args);
}

/** Apply a stash and drop it from the stash list on success. */
export async function popStash(git: SimpleGit, input: ActionPayload<"popStash">): Promise<void> {
  await resolveStash(git, input.selector, input.expectedHash);
  const args = ["stash", "pop"];
  if (input.reinstateIndex) args.push("--index");
  args.push(input.selector);
  await git.raw(args);
}

/** Delete a stash from the stash list. */
export async function dropStash(git: SimpleGit, input: ActionPayload<"dropStash">): Promise<void> {
  await resolveStash(git, input.selector, input.expectedHash);
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
  // The rev-parse the rebuild needs anyway is the one the selector is checked
  // with, so the commit rebuilt is the commit the caller named.
  const sha = await resolveStash(git, input.selector, input.expectedHash);
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
