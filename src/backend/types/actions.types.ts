import type { GitResetMode } from "./git.types";

export type GitCommandStatus = string | null;

type ActionPayloads = {
  addTag: {
    tagName: string;
    commitHash: string;
    lightweight: boolean;
    message: string;
    pushToRemote: string | null;
    force: boolean;
  };
  checkoutBranch: { branchName: string; remoteBranch: string | null; force: boolean };
  checkoutCommit: { commitHash: string };
  cherrypickCommit: {
    commitHash: string;
    parentIndex: number;
    noCommit: boolean;
    recordOrigin: boolean;
  };
  createBranch: { commitHash: string; branchName: string; checkout: boolean; force: boolean };
  dropCommit: { commitHash: string };
  resetFileToRevision: { commitHash: string; filePath: string };
  applyStash: { selector: string; reinstateIndex: boolean };
  popStash: { selector: string; reinstateIndex: boolean };
  dropStash: { selector: string };
  renameStash: { selector: string; message: string };
  fastForwardBranch: { branchName: string };
  resetUncommittedChanges: Record<never, never>;
  cleanUntrackedFiles: Record<never, never>;
  continueOperation: Record<never, never>;
  abortOperation: Record<never, never>;
  markResolved: { filePath: string };
  deleteBranch: { branchName: string; forceDelete: boolean; deleteOnRemotes: boolean };
  deleteRemoteBranch: { branchName: string; remote: string };
  deleteTag: { tagName: string; deleteOnRemote: string | null };
  fetchIntoLocalBranch: {
    remote: string;
    remoteBranch: string;
    localBranch: string;
    force: boolean;
  };
  mergeBranch: { branchName: string; createNewCommit: boolean; squash: boolean; noCommit: boolean };
  mergeCommit: { commitHash: string; createNewCommit: boolean; squash: boolean; noCommit: boolean };
  pullBranch: { branchName: string; remote: string };
  pushBranch: {
    branchName: string;
    /** One or more remotes to push to. */
    remotes: string[];
    forceMode: "normal" | "force" | "forceWithLease";
  };
  pushTag: { tagName: string; remotes: string[] };
  rebaseOn: { obj: string };
  renameBranch: { oldName: string; newName: string };
  resetToCommit: { commitHash: string; resetMode: GitResetMode };
  revertCommit: { commitHash: string; parentIndex: number };
};

/** What became of one ref in a batch action. `status` is null on success and a
 *  formatted git error otherwise — the same shape a single action reports, just
 *  one per ref. */
export type BatchRefResult = { ref: string; status: GitCommandStatus };

/** A batch delete result, plus the one classification the host can make more
 *  reliably than the webview: `notFullyMerged` is read off the *raw* git error,
 *  before `formatGitError` narrows it to its first line. */
export type BatchDeleteResult = BatchRefResult & { notFullyMerged: boolean };

/**
 * Batch actions. Unlike the actions above, each ref succeeds or fails on its
 * own, so the response carries one result per ref instead of a single status —
 * a batch that stopped at the first failure would leave the user with a
 * half-done job and no way to tell where it stopped.
 */
type BatchActionPayloads = {
  deleteBranches: {
    request: {
      /** Branch-list-format refs (`main`, `remotes/origin/main`). Local and
       *  remote-tracking refs arrive mixed and are split by the action, which
       *  is also where the `deleteOnRemotes` overlap is de-duplicated. */
      refs: string[];
      forceDelete: boolean;
      deleteOnRemotes: boolean;
    };
    response: { results: BatchDeleteResult[] };
  };
  pushBranches: {
    request: {
      branchNames: string[];
      remotes: string[];
      forceMode: "normal" | "force" | "forceWithLease";
    };
    response: { results: BatchRefResult[] };
  };
  fastForwardBranches: {
    request: { branchNames: string[] };
    response: { results: BatchRefResult[] };
  };
};

export type BatchActionRequest = {
  [K in keyof BatchActionPayloads]: {
    command: K;
    repo: string;
  } & BatchActionPayloads[K]["request"];
}[keyof BatchActionPayloads];

export type BatchActionResponse = {
  [K in keyof BatchActionPayloads]: { command: K } & BatchActionPayloads[K]["response"];
}[keyof BatchActionPayloads];

export type BatchActionPayload<T extends keyof BatchActionPayloads> =
  BatchActionPayloads[T]["request"];

export type ActionRequest = {
  [K in keyof ActionPayloads]: { command: K; repo: string } & ActionPayloads[K];
}[keyof ActionPayloads];

export type ActionResponse = {
  [K in keyof ActionPayloads]: { command: K; status: GitCommandStatus };
}[keyof ActionPayloads];

export type ActionPayload<T extends keyof ActionPayloads> = ActionPayloads[T];
