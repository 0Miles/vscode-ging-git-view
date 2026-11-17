import { type SimpleGit, simpleGit } from "simple-git";

export async function isGitRepository(repoPath: string, gitPath: string): Promise<boolean> {
  try {
    return await simpleGit({ baseDir: repoPath, binary: gitPath }).checkIsRepo();
  } catch {
    return false;
  }
}

/** The top folder of the working tree `folder` is in, as git spells it
 *  (forward slashes); `null` when `folder` is in none — not a repository, a
 *  bare one, or inside a `.git` folder. */
export async function workingTreeRoot(folder: string, gitPath: string): Promise<string | null> {
  try {
    const root = await simpleGit({ baseDir: folder, binary: gitPath }).revparse([
      "--show-toplevel"
    ]);
    return root.trim() || null;
  } catch {
    return null;
  }
}

/** Where a folder is, as far as git is concerned: in no repository; the top of
 *  a working tree, or a folder inside one; or the folder of a repository with
 *  no working tree to show — a bare repository, or a `.git` folder or inside
 *  one. */
export type GitFolderPlace = "none" | "workTreeTop" | "inWorkTree" | "noWorkTree";

/** Where `folder` is (`GitFolderPlace`), asked of `git` — bound to no
 *  repository, the folder named on the command line. A folder that is not
 *  there, or git failing for any reason, is in none. */
export async function gitFolderPlace(git: SimpleGit, folder: string): Promise<GitFolderPlace> {
  let answer: string;
  try {
    // In this order, one line each. `--show-prefix` alone cannot tell the top
    // of a working tree from a bare repository: both answer an empty line.
    answer = await git.raw(["-C", folder, "rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  } catch {
    return "none";
  }
  const [insideWorkTree, prefix = ""] = answer.split(/\r?\n/);
  if (insideWorkTree.trim() !== "true") return "noWorkTree";
  return prefix.trim() === "" ? "workTreeTop" : "inWorkTree";
}

/** `gitFolderPlace` with the git at `gitPath`. */
export function gitFolderPlaceFor(folder: string, gitPath: string): Promise<GitFolderPlace> {
  return gitFolderPlace(simpleGit({ binary: gitPath }), folder);
}

export async function getRemoteUrl(repoPath: string, gitPath: string): Promise<string | null> {
  try {
    const url = await simpleGit({ baseDir: repoPath, binary: gitPath }).raw([
      "config",
      "--get",
      "remote.origin.url"
    ]);
    return url.trim() || null;
  } catch {
    return null;
  }
}
