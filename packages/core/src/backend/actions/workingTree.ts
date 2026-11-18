import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { GitError, GitPluginError, type SimpleGit } from "simple-git";

import {
  amendBasis,
  headCommit,
  remoteBranchesContainingHead
} from "@ging/core/backend/queries/amend";
import { unmergedFiles } from "@ging/core/backend/queries/unmergedFiles";
import type { CommitRefusal } from "@ging/shared/backend/types";

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
 * Run `git <args>` on `paths`, more than one handed over in a file rather
 * than on the command line (`--pathspec-from-file`, git 2.25+), which on
 * Windows holds only about 32k characters: "Stage All" may name thousands of
 * files. An
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

/** Run `git <args>` on exactly `named`. One path goes on the command line,
 *  which any git takes: the graph's conflict banner marks one file resolved
 *  through `resolveFiles`, and worked before git 2.25 (#468). More go through
 *  a pathspec file. */
async function onNamed(git: SimpleGit, args: string[], named: WholeFiles): Promise<void> {
  if (named.length === 0) return;
  if (named.length === 1) {
    await git.raw(["--literal-pathspecs", ...args, "--", named[0]]);
    return;
  }
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

export type CommitInput = {
  message: string;
  /** Replace HEAD rather than add a commit on it (#407): what is staged, if
   *  anything, goes in with it, and the message replaces its own. */
  amend?: boolean;
  /** Add a `Signed-off-by` trailer (`--signoff`). */
  signOff?: boolean;
  /** Amend HEAD even when it is on a remote-tracking branch, as long as it is
   *  still this commit: the one the user was told about, rewriting pushed
   *  history, and said to go on with. A HEAD that has moved since is asked
   *  about anew. */
  rewritePushed?: string;
};

/** A commit GING declined to make, for a reason it says in its own words
 *  (`CommitRefusal`), not git's. Nothing was changed. */
export class CommitRefusedError extends Error {
  constructor(
    readonly refusal: CommitRefusal,
    detail: string
  ) {
    super(detail);
    this.name = "CommitRefusedError";
  }
}

/**
 * Commit what is staged, with `message` as it is written; with `amend`,
 * replace HEAD with it instead, staged changes or none. Signed with `-S` when
 * `signCommits` (the setting) says so; otherwise no flag at all, so git's own
 * `commit.gpgsign` decides, as for cherry-pick, revert, merge and rebase.
 * Signed off with git's own `--signoff`, as the committer: git adds no second
 * trailer when the message already ends on the same one. Hooks run as they
 * would on the command line.
 *
 * Refused, by GING before git runs (`CommitRefusedError`), when git knows no
 * committer; for an amend, with no commit to amend or an operation in progress
 * (`amendBasis`), and with HEAD already on a remote-tracking branch unless
 * `rewritePushed` names it. Refused by git when there is nothing to commit or
 * the message is empty. `refused` says the caller has just run `refuseCommit`
 * on the same input itself, so it is not run twice.
 */
export async function commitChanges(
  git: SimpleGit,
  input: CommitInput,
  signCommits: boolean = false,
  refused: "checked" | "unchecked" = "unchecked"
): Promise<void> {
  if (refused === "unchecked") await refuseCommit(git, input);
  const args = ["commit"];
  if (input.amend === true) args.push("--amend");
  if (input.signOff === true) args.push("--signoff");
  args.push("-m", input.message);
  if (signCommits) args.push("-S"); // GPG/SSH-sign the new commit
  const before = await headCommit(git);
  const loggedBefore = input.amend === true ? await headLogLength(git) : 0;
  const said = await git.raw(args);
  // Nothing to commit is said on stdout, with nothing on stderr, and
  // simple-git resolves such a run whatever git's exit code. So whether a
  // commit was made is read off HEAD, not off the run. An amend that changes
  // nothing within the second it was made makes the very same commit, which
  // HEAD's reflog still records. With no reflog (`core.logAllRefUpdates`
  // false), such an amend is reported as "git made no commit": nothing then
  // tells it apart from a run that made none.
  const made =
    (await headCommit(git)) !== before ||
    (input.amend === true && (await headLogLength(git)) > loggedBefore);
  if (!made) throw new Error(said.trim() === "" ? "git made no commit" : said.trim());
}

/**
 * Throw the `CommitRefusedError` that `commitChanges` would decline `input`
 * with, if any, changing nothing: for a caller to hear a refusal without
 * making a change of it (a muted watcher, a refresh), and then hand
 * `commitChanges` "checked" so it does not ask again.
 */
export async function refuseCommit(git: SimpleGit, input: CommitInput): Promise<void> {
  if (input.amend === true) await refuseUnamendable(git, input.rewritePushed);
  await refuseUnknownCommitter(git);
}

/** Throw unless HEAD can be amended, and is either not pushed or the very
 *  commit `rewritePushed` names. */
async function refuseUnamendable(git: SimpleGit, rewritePushed: string | undefined): Promise<void> {
  const [basis, head] = await Promise.all([amendBasis(git), headCommit(git)]);
  if (!basis.possible) {
    throw new CommitRefusedError(
      { kind: "cannotAmend", reason: basis.reason },
      `cannot amend: ${basis.reason}`
    );
  }
  if (rewritePushed === head) return;
  const remoteBranches = await remoteBranchesContainingHead(git);
  if (remoteBranches.length > 0) {
    throw new CommitRefusedError(
      { kind: "pushed", head, remoteBranches },
      `HEAD ${head} is on ${remoteBranches.join(", ")}`
    );
  }
}

/** Throw when git cannot say who would commit: `git var` applies the same
 *  strict rule as `git commit` (no auto-detected `(none)` address, and
 *  `user.useConfigOnly`), and says so on stderr. The committer is who a
 *  sign-off names, and the author of a new commit unless told otherwise. */
async function refuseUnknownCommitter(git: SimpleGit): Promise<void> {
  try {
    await git.raw(["var", "GIT_COMMITTER_IDENT"]);
  } catch (e: unknown) {
    // git ran and refused. Not simple-git declining to run it at all, which
    // says nothing about who the committer is.
    if (!(e instanceof GitError) || e instanceof GitPluginError) throw e;
    throw new CommitRefusedError({ kind: "identityUnknown" }, e.message);
  }
}

/** How many entries HEAD's reflog holds; 0 with none. */
async function headLogLength(git: SimpleGit): Promise<number> {
  try {
    return Number((await git.raw(["rev-list", "--walk-reflogs", "--count", "HEAD"])).trim());
  } catch {
    // No reflog (`core.logAllRefUpdates` off): HEAD alone tells.
    return 0;
  }
}
