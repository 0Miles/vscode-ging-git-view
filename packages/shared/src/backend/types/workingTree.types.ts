import type { GitOperation } from "./git.types";

/** How a file differs, on one side of the index: between HEAD and the index
 *  (staged), or between the index and the working tree (unstaged). `untracked`
 *  is only ever unstaged; `conflicted` is an unmerged path, which is neither. */
export type WorkingTreeChange =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked"
  | "conflicted";

/** One changed file of the working tree, repository-relative with "/". */
export type WorkingTreeFile = {
  path: string;
  /** Where a staged rename or copy came from. */
  oldPath?: string;
  change: WorkingTreeChange;
  /** A submodule. Shown but never staged: submodule management is out of
   *  #291's scope, and a submodule changed only inside has nothing to stage. */
  submodule?: true;
};

/** The working tree as `git status` reads it (#403). A file changed both in the
 *  index and after it is in `staged` and in `unstaged`, once each. */
export type WorkingTreeStatus = {
  /** The checked-out branch, or `null` with HEAD detached. */
  branch: string | null;
  /** Between HEAD and the index: what a commit would record. */
  staged: WorkingTreeFile[];
  /** Between the index and the working tree, untracked files included. */
  unstaged: WorkingTreeFile[];
  /** Unmerged paths, from a merge, rebase, cherry-pick or stash that stopped
   *  on a conflict. In neither list above: staging one marks it resolved,
   *  which only "Mark Resolved" does (#410). */
  conflicted: WorkingTreeFile[];
  /** The merge, rebase, cherry-pick or revert in progress, to be continued or
   *  aborted (#410); absent with none. A stash applied with conflicts leaves
   *  none: its conflicts are listed all the same. */
  operation?: GitOperation;
};

/** Why HEAD cannot be amended (#407): there is no commit to amend yet, or an
 *  operation stopped half-way — amending then would fold its work into the
 *  commit before it. */
export type AmendRefusal = "unborn" | GitOperation;

/** What an amend of HEAD would start from: its message, or why there is none. */
export type AmendBasis =
  | { possible: true; message: string }
  | { possible: false; reason: AmendRefusal };

/** Why a commit was not made, when it is something to say in GING's own words
 *  rather than git's (#407). */
export type CommitRefusal =
  /** HEAD, commit `head`, is on these remote-tracking branches (short
   *  names): amending it rewrites history others may have. Made only once the
   *  user says so for that very commit. */
  | { kind: "pushed"; head: string; remoteBranches: string[] }
  | { kind: "cannotAmend"; reason: AmendRefusal }
  /** git knows no committer: `user.name` / `user.email` are not set. */
  | { kind: "identityUnknown" };
