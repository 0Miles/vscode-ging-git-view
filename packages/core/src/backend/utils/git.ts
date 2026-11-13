import { simpleGit } from "simple-git";

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
