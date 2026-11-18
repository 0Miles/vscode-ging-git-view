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

/** The two sides of the working tree a file's diff, and its hunks, are read
 *  from (#406): HEAD ↔ index (`staged`), or index ↔ working tree
 *  (`unstaged`). A hunk of an unstaged diff is staged; one of a staged diff,
 *  unstaged. */
export type HunkArea = "staged" | "unstaged";

/** Lines of one side of a diff, as a hunk header gives them: the first line,
 *  from 1, and how many. With `count` 0 the hunk takes nothing from this
 *  side, and `start` is the line it comes after (0: before the first). */
export type LineSpan = { start: number; count: number };

/** One hunk of a file's diff, as `git diff` cut it: the lines it spans on
 *  each side, context included. */
export type FileHunk = { original: LineSpan; modified: LineSpan };

/** Why a file's diff offers no hunk to stage or unstage on its own (#406):
 *  nothing differs; it is in conflict (#410's to resolve); it has no text
 *  lines (binary); the file is new or gone on one side, or renamed, which is
 *  one change to the whole file; or it is no regular file (a symbolic link, a
 *  submodule, or a change of mode alone). */
export type NoHunksReason =
  | "unchanged"
  | "conflicted"
  | "binary"
  | "added"
  | "deleted"
  | "renamed"
  | "notText";

/** A file's diff in one area, as hunks to stage or unstage one at a time:
 *  `token` names the very diff they were cut from, and a hunk is applied only
 *  while the file's diff is still that one. */
export type FileHunks =
  | { kind: "hunks"; token: string; hunks: FileHunk[] }
  | { kind: "none"; reason: NoHunksReason };

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
