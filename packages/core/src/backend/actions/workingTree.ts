import type { SimpleGit } from "simple-git";

/** Discard all uncommitted changes to tracked files (git reset --hard HEAD). */
export async function resetUncommittedChanges(git: SimpleGit): Promise<void> {
  await git.raw(["reset", "--hard", "HEAD"]);
}

/** Delete all untracked files and directories (git clean -fd). */
export async function cleanUntrackedFiles(git: SimpleGit): Promise<void> {
  await git.raw(["clean", "-fd"]);
}
