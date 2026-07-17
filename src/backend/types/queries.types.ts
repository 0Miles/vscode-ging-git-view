import type {
  CommitOrdering,
  GitCommitDetails,
  GitCommitNode,
  GitFileChange,
  GitOperation,
  GitTagDetails
} from "./git.types";

type QueryPayloads = {
  commitDetails: {
    request: { repo: string; commitHash: string; isStash?: boolean };
    response: { commitDetails: GitCommitDetails | null };
  };
  /** The in-progress git operation (merge/rebase/cherry-pick/revert) and its
   *  unresolved conflict files, for the conflict-resolution banner. */
  operationState: {
    request: { repo: string };
    response: { operation: GitOperation | null; conflictedFiles: string[] };
  };
  /** Files changed between two arbitrary commits. */
  compareCommits: {
    request: { repo: string; fromHash: string; toHash: string };
    response: { fromHash: string; toHash: string; fileChanges: GitFileChange[] | null };
  };
  /** Files predicted to conflict if `theirs` is merged into `ours`. `token`
   *  correlates the response with the dialog that requested it (the messaging
   *  is command-keyed, not request-id'd). */
  predictConflicts: {
    request: { repo: string; ours: string; theirs: string; token: number };
    response: { ok: boolean; conflictFiles: string[]; token: number };
  };
  loadBranches: {
    request: { showRemoteBranches: boolean; hard: boolean };
    response: {
      branches: string[];
      head: string | null;
      hard: boolean;
      isRepo: boolean;
      /** ref → last commit time (unix seconds); present only when the host
       *  requested dates (the side-view does, the graph panel doesn't). */
      branchDates?: Record<string, number>;
      /** The branch filter resolved by the host (the side-view's per-repo
       *  selection, or the configured default). Empty = show all. */
      filter: string[];
    };
  };
  loadRemotes: {
    request: Record<never, never>;
    response: { remotes: string[]; pushDefault: string | null };
  };
  tagDetails: {
    request: { repo: string; tagName: string };
    response: { details: GitTagDetails | null };
  };
  loadCommits: {
    request: {
      repo: string;
      /** Branch refs to show commits from. A single `""` means all
       *  branches; entries may be branch names or `glob:<pattern>` markers. */
      branchNames: string[];
      maxCommits: number;
      showRemoteBranches: boolean;
      hard: boolean;
      commitOrder?: CommitOrdering;
      /** Remote names whose branches are hidden. */
      hiddenRemotes?: string[];
    };
    response: {
      commits: GitCommitNode[];
      head: string | null;
      moreCommitsAvailable: boolean;
      hard: boolean;
    };
  };
};

export type QueryRequest = {
  [K in keyof QueryPayloads]: { command: K } & QueryPayloads[K]["request"];
}[keyof QueryPayloads];

export type QueryResponse = {
  [K in keyof QueryPayloads]: { command: K } & QueryPayloads[K]["response"];
}[keyof QueryPayloads];

export type QueryResult<T extends keyof QueryPayloads> = QueryPayloads[T]["response"];
