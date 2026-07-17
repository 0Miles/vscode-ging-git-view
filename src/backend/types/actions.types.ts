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

export type ActionRequest = {
  [K in keyof ActionPayloads]: { command: K; repo: string } & ActionPayloads[K];
}[keyof ActionPayloads];

export type ActionResponse = {
  [K in keyof ActionPayloads]: { command: K; status: GitCommandStatus };
}[keyof ActionPayloads];

export type ActionPayload<T extends keyof ActionPayloads> = ActionPayloads[T];
