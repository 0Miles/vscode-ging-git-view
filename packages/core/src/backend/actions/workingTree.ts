import type { SimpleGit } from "simple-git";

/** Discard all uncommitted changes to tracked files (git reset --hard HEAD). */
export async function resetUncommittedChanges(git: SimpleGit): Promise<void> {
  await git.raw(["reset", "--hard", "HEAD"]);
}

/** Delete all untracked files and directories (git clean -fd). */
export async function cleanUntrackedFiles(git: SimpleGit): Promise<void> {
  await git.raw(["clean", "-fd"]);
}

/** Repository-relative paths, each taken as written: `--literal-pathspecs`
 *  keeps a file named `*.txt` from staging every text file. `null` is every
 *  change in the working tree. */
export type WholeFiles = string[] | null;

/**
 * Stage `paths` whole, as they are in the working tree: a change, a new file,
 * or a deletion (`add -A`, which `add` alone would refuse for a path that is
 * gone). Never part of a file: that is #406's hunk staging.
 */
export async function stageFiles(git: SimpleGit, paths: WholeFiles): Promise<void> {
  if (paths === null) await git.raw(["add", "-A"]);
  else if (paths.length > 0) await git.raw(["--literal-pathspecs", "add", "-A", "--", ...paths]);
}

/**
 * Take `paths` out of the index, back to what HEAD has, leaving the working
 * tree as it is. On a branch with no commit yet, back to not being in the
 * index at all. A staged rename is unstaged by both its paths.
 */
export async function unstageFiles(git: SimpleGit, paths: WholeFiles): Promise<void> {
  // `reset` reads an unborn branch as an empty tree (git 1.8.2+), which is
  // why it serves here rather than `restore --staged`, which needs a HEAD.
  if (paths === null) await git.raw(["reset", "-q"]);
  else if (paths.length > 0) await git.raw(["--literal-pathspecs", "reset", "-q", "--", ...paths]);
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
