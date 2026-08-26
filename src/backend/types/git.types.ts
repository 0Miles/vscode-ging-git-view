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

/** A branch head placed in the unbounded commit history for Find navigation. */
export type BranchSearchEntry = {
  /** Canonical ref used as branch identity across refreshes. */
  ref: string;
  /** Display ref (`main`, `origin/main`). */
  name: string;
  hash: string;
  /** Zero-based position in `git log` — counted straight off the bare
   *  `git log --format=%H` this index is built from, which has no working-tree
   *  entry and labels nothing as a stash. It is deliberately **not** a graph
   *  row: the graph splices stash rows in among the commits, so a row index
   *  runs ahead of this by the stash rows sitting above it, and
   *  `buildFindMatches` converts between the two (see
   *  `tests/webview/find.test.ts`).
   *
   *  What makes that conversion sound is that this log is scoped and ordered by
   *  the same two helpers as the graph's own (`gitLogScopeArgs` /
   *  `gitLogTraversalArgs`), so both walk the same entries in the same order —
   *  and this is the ruler `--max-count` is measured on, which is why
   *  `planFindLoad` sizes its window off it. Naming rule across Find: `depth`
   *  is a graph row, `logDepth` is this. */
  logDepth: number;
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

/** One of the branch's own commits, as listed in the redundancy dialog. */
export type RedundancyCommit = {
  hash: string;
  subject: string;
  author: string;
  email: string;
  /** Author date, unix seconds. */
  date: number;
  /** The default branch already carries a commit with an identical patch. */
  covered: boolean;
};

/** Whether a branch still has anything to contribute to the default branch —
 *  the answer to the on-demand check (ADR-0006), never a stored fact. */
export type BranchRedundancy =
  /** Merging the branch into the default branch would change nothing. */
  | { kind: "redundant"; defaultBranch: string; defaultBranchDate: number }
  /** Merging would still change something. `commits` are the branch's own
   *  commits, newest first, each marked by patch-id with whether the default
   *  branch already carries it. Evidence shown alongside the verdict, never the
   *  verdict itself — a commit can be `covered` on a branch that is still
   *  unmerged (the change was applied there and later reverted). */
  | {
      kind: "unmerged";
      defaultBranch: string;
      defaultBranchDate: number;
      commits: RedundancyCommit[];
      /** The branch has more commits than `commits` lists. */
      truncated: boolean;
    }
  | { kind: "unknown"; reason: "noDefaultBranch" | "noMergeBase" | "unsupported" };
