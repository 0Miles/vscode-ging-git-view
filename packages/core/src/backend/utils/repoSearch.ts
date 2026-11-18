import * as fs from "node:fs/promises";

import { isGitRepository } from "@ging/core/backend/utils/git";
import { submodulePathsFromGitmodules } from "@ging/core/backend/utils/gitmodules";
import { evalPromises } from "@ging/core/backend/utils/promise";

async function isDirectory(path: string): Promise<boolean> {
  return fs
    .stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/** Whether `dir` has a `.git` entry (a directory for a normal clone, or a
 *  gitlink file for a submodule) — one stat, no spawn. It decides which
 *  initialised submodules to keep, and which folders below a search's start are
 *  worth asking git about. It does not prove a repository (git may not
 *  recognise the entry), and unlike `isGitRepository` it is false for a
 *  subfolder of a repository. */
async function hasGitEntry(dir: string): Promise<boolean> {
  return fs
    .stat(dir + "/.git")
    .then(() => true)
    .catch(() => false);
}

/**
 * Resolve the git submodules declared in `repo`'s `.gitmodules` to their repo
 * roots, keeping only the ones that are actually initialised (have a
 * `.git` entry at the declared path), in declaration order.
 */
async function submoduleRepos(repo: string): Promise<string[]> {
  const content = await fs.readFile(repo + "/.gitmodules", { encoding: "utf8" }).catch(() => null);
  if (content === null) return [];
  const dirs = submodulePathsFromGitmodules(content).map((p) => repo + "/" + p);
  const checks = await evalPromises(dirs, 2, async (dir) =>
    (await hasGitEntry(dir)) ? dir : null
  );
  return checks.filter((d): d is string => d !== null);
}

/**
 * The repositories in `directory` and up to `maxDepth` folders below it, each
 * with the initialised submodules its `.gitmodules` declares. Folders in or
 * under `knownRepoPaths` are skipped.
 *
 * Git is asked about `directory` itself, so a search that starts anywhere
 * inside a working tree finds it. Below the start, only folders with a `.git`
 * entry are put to git, a spawn apiece, rather than every folder walked: below
 * a start that is in no working tree, a folder normally enters one only at its
 * top, where the `.git` entry is. Folders that reach into a working tree
 * without one are not found below the start — a junction or symlink to a
 * repository's subfolder, or a `core.worktree` pointing into the walked tree.
 */
export function searchDirectoryForRepos(
  directory: string,
  maxDepth: number,
  gitPath: string,
  knownRepoPaths: string[]
): Promise<string[]> {
  return search(directory, maxDepth, gitPath, knownRepoPaths, true);
}

async function search(
  directory: string,
  maxDepth: number,
  gitPath: string,
  knownRepoPaths: string[],
  isStart: boolean
): Promise<string[]> {
  if (knownRepoPaths.some((r) => directory === r || directory.startsWith(r + "/"))) {
    return [];
  }

  // A `.git` entry git does not take for a repository (an empty folder, say)
  // is not one, and the walk goes on below it.
  const isRepo =
    (isStart || (await hasGitEntry(directory))) && (await isGitRepository(directory, gitPath));
  if (isRepo) {
    // Also surface any git submodules declared in the repo's .gitmodules.
    return [directory, ...(await submoduleRepos(directory))];
  }

  if (maxDepth <= 0) {
    return [];
  }

  const dirContents = await fs.readdir(directory).catch(() => null);
  if (dirContents === null) {
    return [];
  }

  const dirs: string[] = [];
  for (let i = 0; i < dirContents.length; i++) {
    if (dirContents[i] !== ".git" && (await isDirectory(directory + "/" + dirContents[i]))) {
      dirs.push(directory + "/" + dirContents[i]);
    }
  }

  const results = await evalPromises(dirs, 2, (dir) =>
    search(dir, maxDepth - 1, gitPath, knownRepoPaths, false)
  );
  return results.flat();
}
