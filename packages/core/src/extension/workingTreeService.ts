import type { SimpleGit } from "simple-git";

import {
  type CommitInput,
  CommitRefusedError,
  commitChanges,
  refuseCommit,
  stageFiles,
  unstageFiles,
  type WholeFiles
} from "@ging/core/backend/actions/workingTree";
import { amendBasis } from "@ging/core/backend/queries/amend";
import { workingTreeStatus } from "@ging/core/backend/queries/workingTreeStatus";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { RunRepoMutation } from "@ging/core/host/ports";
import type { AmendBasis, CommitRefusal, WorkingTreeStatus } from "@ging/shared/backend/types";

/** What each call answers: the working tree as it is afterwards, what an
 *  amend of HEAD would start from (#407), and why the call failed, if it did.
 *  `status` and `amend` are `null` only when they could not be read. A commit
 *  GING declined to make says why in `refused` rather than in `error`. */
export type WorkingTreeAnswer = {
  status: WorkingTreeStatus | null;
  amend: AmendBasis | null;
  error: string | null;
  refused?: CommitRefusal;
};

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
  /** Commit what is staged, or amend HEAD (#407). An amend of a pushed HEAD
   *  is answered `refused: pushed` with that HEAD's commit, and made only
   *  once asked again with `rewritePushed` naming it. */
  commit(input: CommitInput): Promise<WorkingTreeAnswer>;
};

/**
 * The working tree of one repository as a host's screen works it (#403): its
 * status, whole-file stage and unstage, and commit or amend (#407).
 * Host-neutral: the desktop host's working tree panel is today's only caller.
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

  /** The status and the amend basis, side by side: both only read. */
  const read = async (
    error: string | null,
    refused?: CommitRefusal
  ): Promise<WorkingTreeAnswer> => {
    const git = deps.git();
    const [status, amend] = await Promise.allSettled([workingTreeStatus(git), amendBasis(git)]);
    const unread = [status, amend].find((r) => r.status === "rejected");
    return {
      status: status.status === "fulfilled" ? status.value : null,
      amend: amend.status === "fulfilled" ? amend.value : null,
      error: error ?? (unread === undefined ? null : formatGitError(unread.reason)),
      ...(refused !== undefined && { refused })
    };
  };

  /** Run `change` as a repo mutation, then read the status, whatever it did.
   *  `refuse` first, outside it: a change declined is no change, so the
   *  watcher is not muted for it nor the graph refreshed after it. */
  const mutate = (
    change: (git: SimpleGit) => Promise<void>,
    refuse: (git: SimpleGit) => Promise<void> = async () => {}
  ) =>
    inTurn(async () => {
      let error: string | null = null;
      let refused: CommitRefusal | undefined;
      try {
        await refuse(deps.git());
        await deps.runRepoMutation(deps.repo(), () => change(deps.git()));
      } catch (e: unknown) {
        if (e instanceof CommitRefusedError) refused = e.refusal;
        else error = formatGitError(e);
      }
      return read(error, refused);
    });

  return {
    status: () => inTurn(() => read(null)),
    stage: (paths) => mutate((git) => stageFiles(git, paths)),
    unstage: (paths) => mutate((git) => unstageFiles(git, paths)),
    commit: (input) =>
      mutate(
        // Checked just before, outside the mutation: not asked twice.
        (git) => commitChanges(git, input, deps.signCommits(), "checked"),
        (git) => refuseCommit(git, input)
      )
  };
}
