import type { GitFileChangeType } from "@/backend/types";
import { abbrevCommit } from "@/backend/utils/string";

/** A file change of a commit to open in a diff editor. */
export type CommitDiffRequest = {
  repo: string;
  commitHash: string;
  /** The file's path on the left: before the change. */
  oldFilePath: string;
  /** The file's path in `commitHash`. */
  newFilePath: string;
  type: GitFileChangeType;
  /** The commit to compare against; the commit's first parent without one. */
  fromHash?: string;
  /** A 1-based line of `newFilePath` in `commitHash` to reveal and put the
   *  cursor on. */
  revealLine?: number;
};

/** One side of a diff editor: a file's contents at a commit. */
export type DiffSide = { repo: string; filePath: string; commit: string };

/** What a diff editor of a commit's file change shows. */
export type CommitDiffView = {
  left: DiffSide;
  right: DiffSide;
  title: string;
  /** The right side's line to reveal, 0-based as an editor counts; null for
   *  none. */
  reveal: number | null;
};

/** The titles of a file added or deleted by a commit, given its short SHA. */
export type CommitDiffLabels = {
  addedIn: (abbrevHash: string) => string;
  deletedIn: (abbrevHash: string) => string;
};

/**
 * The diff editor of a commit's change to a file: the file before (`oldFilePath`
 * at `fromHash`, or at the commit's first parent) on the left, and as the commit
 * left it on the right. A side with no such file — the parent of an added file,
 * or of a root commit; the commit of a deleted one — reads as an empty document
 * (see `getCommitFileContent`).
 */
export function commitDiffView(
  request: CommitDiffRequest,
  labels: CommitDiffLabels
): CommitDiffView {
  const { repo, commitHash, oldFilePath, newFilePath, type, fromHash, revealLine } = request;
  const abbrevHash = abbrevCommit(commitHash);
  const leftRev = fromHash !== undefined ? fromHash : commitHash + "^";
  const fileName = newFilePath.split("/").at(-1);
  const change =
    type === "A"
      ? labels.addedIn(abbrevHash)
      : type === "D"
        ? labels.deletedIn(abbrevHash)
        : (fromHash !== undefined ? abbrevCommit(fromHash) : abbrevHash + "^") + " ↔ " + abbrevHash;
  return {
    left: { repo, filePath: oldFilePath, commit: leftRev },
    right: { repo, filePath: newFilePath, commit: commitHash },
    title: `${fileName} (${change})`,
    reveal: revealLine === undefined ? null : revealLine - 1
  };
}
