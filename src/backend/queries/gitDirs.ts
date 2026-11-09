import * as path from "node:path";

import { spawnGit } from "@/backend/gitSpawn";

import { BLAME_TIMEOUT_MS, type BlameGit } from "./blameFile";

/** Where a repository's git metadata really lives. */
export type GitDirs = {
  /** This working tree's own git dir, which holds its `HEAD`: `.git` for a
   *  plain repository, `.git/worktrees/<name>` for a linked worktree,
   *  `.git/modules/<name>` of the superproject for a submodule. */
  gitDir: string;
  /** The git dir shared by every worktree of the repository, which holds the
   *  branches (`refs/heads`, `packed-refs`). The same as `gitDir` except in a
   *  linked worktree. */
  commonDir: string;
};

/**
 * Ask git where `repoPath`'s git dir and common dir are, as absolute paths;
 * null when git can't say (not a repository, past the deadline, git failed).
 * `.git` at the top of a worktree or submodule is only a file pointing
 * elsewhere, so the directories can't be guessed from the repository path.
 */
export async function findGitDirs(git: BlameGit): Promise<GitDirs | null> {
  const remaining = (git.deadline ?? Date.now() + BLAME_TIMEOUT_MS) - Date.now();
  if (remaining <= 0) return null;
  const result = await spawnGit({
    gitPath: git.gitPath,
    cwd: git.repoPath,
    args: ["rev-parse", "--git-dir", "--git-common-dir"],
    timeoutMs: remaining,
    onCommand: git.onCommand,
    gitEnv: git.gitEnv
  });
  if (result.kind !== "ok" || result.exitCode !== 0) return null;
  // Each comes back relative to `repoPath` (".git") or absolute.
  const [gitDir, commonDir] = result.stdout
    .toString()
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => path.resolve(git.repoPath, line));
  return gitDir === undefined || commonDir === undefined ? null : { gitDir, commonDir };
}
