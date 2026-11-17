import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { SimpleGit } from "simple-git";

import { unmergedFiles } from "@ging/core/backend/queries/unmergedFiles";

/** Discard all uncommitted changes to tracked files (git reset --hard HEAD). */
export async function resetUncommittedChanges(git: SimpleGit): Promise<void> {
  await git.raw(["reset", "--hard", "HEAD"]);
}

/** Delete all untracked files and directories (git clean -fd). */
export async function cleanUntrackedFiles(git: SimpleGit): Promise<void> {
  await git.raw(["clean", "-fd"]);
}

/** Repository-relative paths, each taken as written: `--literal-pathspecs`
 *  keeps a file named `*.txt` from staging every text file. Always named:
 *  there is no "everything", because a pathspec-less `add -A` would mark a
 *  conflicted file resolved and a pathspec-less `reset` would drop the merge
 *  itself (MERGE_HEAD) — "Stage All" is every path the panel lists. */
export type WholeFiles = readonly string[];

/**
 * Run `git <args>` on `paths`, handed over in a file rather than on the
 * command line (`--pathspec-from-file`, git 2.25+), which on Windows holds
 * only about 32k characters: "Stage All" may name thousands of files. An
 * unmerged path is never among them: staging or unstaging one resolves the
 * conflict, which only `resolveFiles` does (#410), never a whole-file stage.
 */
async function onPaths(git: SimpleGit, args: string[], paths: WholeFiles): Promise<void> {
  const conflicted = new Set(await unmergedFiles(git));
  await onNamed(
    git,
    args,
    paths.filter((p) => !conflicted.has(p))
  );
}

/** Run `git <args>` on exactly `named`, through a pathspec file. */
async function onNamed(git: SimpleGit, args: string[], named: WholeFiles): Promise<void> {
  if (named.length === 0) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ging-pathspec-"));
  const file = path.join(dir, "paths");
  try {
    await fs.writeFile(file, named.join("\0"));
    await git.raw([
      "--literal-pathspecs",
      ...args,
      `--pathspec-from-file=${file}`,
      "--pathspec-file-nul"
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Stage `paths` whole, as they are in the working tree: a change, a new file,
 * or a deletion (`add -A`, which `add` alone would refuse for a path that is
 * gone). Never part of a file: that is #406's hunk staging.
 */
export async function stageFiles(git: SimpleGit, paths: WholeFiles): Promise<void> {
  await onPaths(git, ["add", "-A"], paths);
}

/**
 * Mark the conflicted ones among `paths` resolved (#410): each staged whole as
 * the working tree has it now — the file as the user left it, or its deletion
 * when that is what they chose (`add -A`). A path named that is not in
 * conflict is left alone: this is never a way to stage anything else. The
 * operation stays in progress (MERGE_HEAD and the like); continuing it is a
 * step of its own. Whether markers remain is the caller's to ask about.
 */
export async function resolveFiles(git: SimpleGit, paths: WholeFiles): Promise<void> {
  const conflicted = new Set(await unmergedFiles(git));
  await onNamed(
    git,
    ["add", "-A"],
    paths.filter((p) => conflicted.has(p))
  );
}

/**
 * Take `paths` out of the index, back to what HEAD has, leaving the working
 * tree as it is. On a branch with no commit yet, back to not being in the
 * index at all. A staged rename is unstaged by both its paths.
 */
export async function unstageFiles(git: SimpleGit, paths: WholeFiles): Promise<void> {
  // `reset` reads an unborn branch as an empty tree (git 1.8.2+), which is
  // why it serves here rather than `restore --staged`, which needs a HEAD.
  // With paths, it leaves MERGE_HEAD and the like alone.
  await onPaths(git, ["reset", "-q"], paths);
}

/**
 * Commit what is staged, with `message` as it is written. Signed with `-S`
 * when `signCommits` (the setting) says so; otherwise no flag at all, so git's
 * own `commit.gpgsign` decides, as for cherry-pick, revert, merge and rebase.
 * Hooks run as they would on the command line. Refused by git when nothing is
 * staged or the message is empty.
 */
export async function commitChanges(
  git: SimpleGit,
  input: { message: string },
  signCommits: boolean = false
): Promise<void> {
  const args = ["commit", "-m", input.message];
  if (signCommits) args.push("-S"); // GPG/SSH-sign the new commit
  const before = await headCommit(git);
  const said = await git.raw(args);
  // Nothing to commit is said on stdout, with nothing on stderr, and
  // simple-git resolves such a run whatever git's exit code. So whether a
  // commit was made is read off HEAD, not off the run.
  if ((await headCommit(git)) === before) {
    throw new Error(said.trim() === "" ? "git made no commit" : said.trim());
  }
}

/** HEAD's commit, or "" on a branch with none yet. */
async function headCommit(git: SimpleGit): Promise<string> {
  // `--verify -q` fails quietly on an unborn branch, which simple-git
  // resolves with the empty output.
  return (await git.raw(["rev-parse", "--verify", "-q", "HEAD"])).trim();
}
