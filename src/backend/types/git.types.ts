/* Git Data Model Types */

export type GitRef = {
  hash: string;
  name: string;
  type: "head" | "tag" | "remote" | "stash";
};

export type GitRefData = {
  head: string | null;
  refs: GitRef[];
};

export type GitCommitNode = {
  hash: string;
  parentHashes: string[];
  author: string;
  email: string;
  date: number;
  message: string;
  refs: GitRef[];
  /** git's `%G?` signature status (G/B/U/X/Y/R/E); "" or omitted when not requested. */
  signatureStatus?: string;
};

export type GitLogEntry = {
  hash: string;
  parentHashes: string[];
  author: string;
  email: string;
  date: number;
  message: string;
  signatureStatus?: string;
};

export type GitFileChange = {
  oldFilePath: string;
  newFilePath: string;
  type: GitFileChangeType;
  additions: number | null;
  deletions: number | null;
};

export type GitCommitDetails = {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  committer: string;
  committerEmail: string;
  authorDate: number;
  commitDate: number;
  body: string;
  fileChanges: GitFileChange[];
};

export type GitTagDetails = {
  tagHash: string;
  commitHash: string;
  name: string;
  email: string;
  date: number | null;
  message: string;
  /** git's `%(signature:grade)` for the tag (G/B/U/X/Y/R/E); "" when unsigned
   *  or unsupported by the git version. */
  signatureStatus: string;
};

export type GitFileChangeType = "A" | "M" | "D" | "R";
export type DateType = "Author Date" | "Commit Date";
export type CommitOrdering = "date" | "author-date" | "topo";
export type GitResetMode = "soft" | "mixed" | "hard";
/** An in-progress git operation that can be continued or aborted. */
export type GitOperation = "merge" | "rebase" | "cherrypick" | "revert";
