import * as fs from "node:fs/promises";

import { isGitRepository } from "@/backend/utils/git";
import { submodulePathsFromGitmodules } from "@/backend/utils/gitmodules";
import { evalPromises } from "@/backend/utils/promise";

async function isDirectory(path: string): Promise<boolean> {
  return fs
    .stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/** Whether `dir` is its own git repository root — i.e. it has a `.git` entry
 *  (a directory for a normal clone, or a gitlink file for a submodule). This is
 *  stricter than `isGitRepository`, which is also true for any subfolder of a
 *  repository. */
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

export async function searchDirectoryForRepos(
  directory: string,
  maxDepth: number,
  gitPath: string,
  knownRepoPaths: string[]
): Promise<string[]> {
  if (knownRepoPaths.some((r) => directory === r || directory.startsWith(r + "/"))) {
    return [];
  }

  const isRepo = await isGitRepository(directory, gitPath);
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
    searchDirectoryForRepos(dir, maxDepth - 1, gitPath, knownRepoPaths)
  );
  return results.flat();
}
