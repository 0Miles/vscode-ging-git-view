import type { SimpleGit } from "simple-git";

/** The repository `initRepository` leaves in a folder, and whether it made it. */
export type InitializedRepo = {
  /** Its top folder, as git spells it (forward slashes): how every repository
   *  the graph knows is spelled. */
  repo: string;
  /** False when the folder already was the top of a working tree, which is
   *  then left as it was. */
  created: boolean;
};

/** Whether `folder` is the top of a working tree: git, run in it, finds no
 *  path from the top to it. Any failure — no such folder, no repository, the
 *  inside of a `.git` folder — is a no. */
async function isWorkingTreeTop(git: SimpleGit, folder: string): Promise<boolean> {
  try {
    return (await git.raw(["-C", folder, "rev-parse", "--show-prefix"])).trim() === "";
  } catch {
    return false;
  }
}

/**
 * A repository in `folder` (#394): `git init` there — git makes the folder if
 * it is not there yet — unless it already is the top of a working tree, which
 * is left as it is rather than re-initialised. A folder inside another
 * repository gets one of its own, as `git init` gives it.
 *
 * `git` is bound to no repository: the folder is named on each command line
 * (`-C`), not as the client's `baseDir`, which must already exist.
 */
export async function initRepository(git: SimpleGit, folder: string): Promise<InitializedRepo> {
  const existing = await isWorkingTreeTop(git, folder);
  if (!existing) await git.raw(["init", "--", folder]);
  const repo = (await git.raw(["-C", folder, "rev-parse", "--show-toplevel"])).trim();
  return { repo, created: !existing };
}
