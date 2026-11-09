import * as path from "node:path";

import { type GitRunOptions, runWithin } from "@ging/core/backend/gitRun";

/** How long finding the git dirs may take when the caller sets no deadline. */
const FIND_TIMEOUT_MS = 5000;

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
export async function findGitDirs(git: GitRunOptions): Promise<GitDirs | null> {
  const deadline = git.deadline ?? Date.now() + FIND_TIMEOUT_MS;
  // `--absolute-git-dir` as elsewhere (merge, operationState); the common dir
  // has no absolute form before git 2.31's `--path-format`, so it can come
  // back relative to `repoPath` (".git").
  const result = await runWithin(git, deadline, [
    "rev-parse",
    "--absolute-git-dir",
    "--git-common-dir"
  ]);
  if (result?.kind !== "ok" || result.exitCode !== 0) return null;
  const [gitDir, commonDir] = result.stdout
    .toString()
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => path.resolve(git.repoPath, line));
  return gitDir === undefined || commonDir === undefined ? null : { gitDir, commonDir };
}

/** A file-system watch: `glob` under the folder `base`. */
export type WatchPath = { base: string; glob: string };

/**
 * What to watch to hear of every commit, checkout, reset or branch update
 * that moves what a file blames to:
 *
 * - `HEAD` in the git dir: a checkout, or a commit on a detached HEAD.
 * - `logs/HEAD` in the git dir: HEAD's reflog, appended on every commit,
 *   checkout and reset in this worktree. A plain file, so a non-recursive
 *   watch, which `files.watcherExclude` (often set to `**\/.git/**`) can't
 *   silence the way it does the recursive one on `refs/heads`.
 * - `refs/heads/**` and `packed-refs` in the common dir: a branch moved from
 *   another worktree or by plumbing, and refs packed by `git gc`.
 */
export function gitDirWatchPaths(dirs: GitDirs): WatchPath[] {
  return [
    { base: dirs.gitDir, glob: "HEAD" },
    { base: path.join(dirs.gitDir, "logs"), glob: "HEAD" },
    { base: path.join(dirs.commonDir, "refs", "heads"), glob: "**" },
    { base: dirs.commonDir, glob: "packed-refs" }
  ];
}
