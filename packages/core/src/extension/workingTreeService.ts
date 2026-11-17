import type { SimpleGit } from "simple-git";

import { abortOperation, continueOperation } from "@ging/core/backend/actions/operation";
import {
  commitChanges,
  resolveFiles,
  stageFiles,
  unstageFiles,
  type WholeFiles
} from "@ging/core/backend/actions/workingTree";
import { workingTreeStatus } from "@ging/core/backend/queries/workingTreeStatus";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { RunRepoMutation } from "@ging/core/host/ports";
import type { WorkingTreeStatus } from "@ging/shared/backend/types";

/** What each call answers: the working tree as it is afterwards, and why the
 *  call failed, if it did. `status` is `null` only when it could not be read. */
export type WorkingTreeAnswer = { status: WorkingTreeStatus | null; error: string | null };

export type WorkingTreeServiceDeps = {
  /** The repository's git client. */
  git: () => SimpleGit;
  /** The repository the changes are made to, for `runRepoMutation`. */
  repo: () => string;
  /** The `signCommits` setting, read at each commit. */
  signCommits: () => boolean;
  /** How the host makes a change to the repository outside the graph's
   *  bridge: its watcher muted across it, the graph refreshed after, so a
   *  commit shows up in the graph (ADR-0013). */
  runRepoMutation: RunRepoMutation;
};

export type WorkingTreeService = {
  status(): Promise<WorkingTreeAnswer>;
  /** Stage these files whole; never an unmerged one. "Stage All" names every
   *  file listed. */
  stage(paths: WholeFiles): Promise<WorkingTreeAnswer>;
  /** Unstage these files whole; never an unmerged one. */
  unstage(paths: WholeFiles): Promise<WorkingTreeAnswer>;
  commit(message: string): Promise<WorkingTreeAnswer>;
  /** Mark the conflicted ones among these files resolved, each staged whole
   *  as it is (#410); any other path named is left alone. Whether conflict
   *  markers remain is the caller's to ask first (`ConflictCommands`). */
  resolve(paths: WholeFiles): Promise<WorkingTreeAnswer>;
  /** Continue the merge, rebase, cherry-pick or revert in progress; refused
   *  while a conflict remains. */
  continueOperation(): Promise<WorkingTreeAnswer>;
  /** Abort the operation in progress, back to where it started. */
  abortOperation(): Promise<WorkingTreeAnswer>;
};

/**
 * The working tree of one repository as a host's screen works it (#403): its
 * status, whole-file stage and unstage, and commit; and in a conflict (#410),
 * marking files resolved and continuing or aborting the operation. Host-neutral: the desktop
 * host's working tree panel is today's only caller.
 *
 * Every call answers with the status read after it, failed or not, so the
 * caller draws what is there rather than what it asked for. Calls run one at
 * a time in the order made: a stage clicked twice, or a commit right after a
 * stage, never runs git twice at once on the same index.
 */
export function createWorkingTreeService(deps: WorkingTreeServiceDeps): WorkingTreeService {
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  const read = async (error: string | null): Promise<WorkingTreeAnswer> => {
    try {
      return { status: await workingTreeStatus(deps.git()), error };
    } catch (e: unknown) {
      return { status: null, error: error ?? formatGitError(e) };
    }
  };

  /** Run `change` as a repo mutation, then read the status, whatever it did. */
  const mutate = (change: (git: SimpleGit) => Promise<void>) =>
    inTurn(async () => {
      let error: string | null = null;
      try {
        await deps.runRepoMutation(deps.repo(), () => change(deps.git()));
      } catch (e: unknown) {
        error = formatGitError(e);
      }
      return read(error);
    });

  return {
    status: () => inTurn(() => read(null)),
    stage: (paths) => mutate((git) => stageFiles(git, paths)),
    unstage: (paths) => mutate((git) => unstageFiles(git, paths)),
    commit: (message) => mutate((git) => commitChanges(git, { message }, deps.signCommits())),
    resolve: (paths) => mutate((git) => resolveFiles(git, paths)),
    continueOperation: () => mutate(continueOperation),
    abortOperation: () => mutate(abortOperation)
  };
}
