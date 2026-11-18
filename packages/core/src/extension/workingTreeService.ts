import type { SimpleGit } from "simple-git";

import {
  applyHunkPatch,
  type HunkChoice,
  hunkPatch,
  NoHunkError,
  StaleHunkError
} from "@ging/core/backend/actions/hunk";
import { abortOperation, continueOperation } from "@ging/core/backend/actions/operation";
import {
  type CommitInput,
  CommitRefusedError,
  commitChanges,
  refuseCommit,
  resolveFiles,
  stageFiles,
  unstageFiles,
  type WholeFiles
} from "@ging/core/backend/actions/workingTree";
import { amendBasisOf, headMessage } from "@ging/core/backend/queries/amend";
import {
  type DiffRun,
  offeredHunks,
  readFileDiff,
  readHead
} from "@ging/core/backend/queries/fileHunks";
import { workingTreeStatus } from "@ging/core/backend/queries/workingTreeStatus";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { RunRepoMutation } from "@ging/core/host/ports";
import type {
  AmendBasis,
  CommitRefusal,
  FileHunk,
  FileHunks,
  HunkArea,
  NoHunksReason,
  WorkingTreeStatus
} from "@ging/shared/backend/types";

export type { HunkChoice } from "@ging/core/backend/actions/hunk";
export type { DiffRun } from "@ging/core/backend/queries/fileHunks";

/** What became of one hunk asked to be staged or unstaged (#406). `stale`:
 *  the file's diff is no longer the one the hunk was shown from; `none`: it
 *  has no hunk to apply on its own. Neither changed anything. */
export type HunkOutcome =
  /** `hunk`: its lines, as the diff it was applied from gave them. */
  | { kind: "applied"; hunk: FileHunk }
  | { kind: "stale" }
  | { kind: "none"; reason: NoHunksReason }
  | { kind: "failed"; error: string };

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
  /** How git is run for what a git client cannot read: a file's diff as
   *  bytes, in whatever encoding the file is in (#406). */
  diffRun: () => DiffRun;
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
  /** Mark the conflicted ones among these files resolved, each staged whole
   *  as it is (#410); any other path named is left alone. Whether conflict
   *  markers remain is the caller's to ask first (`ConflictCommands`). */
  resolve(paths: WholeFiles): Promise<WorkingTreeAnswer>;
  /** Continue the merge, rebase, cherry-pick or revert in progress; refused
   *  while a conflict remains. */
  continueOperation(): Promise<WorkingTreeAnswer>;
  /** Abort the operation in progress, back to where it started. */
  abortOperation(): Promise<WorkingTreeAnswer>;
  /** HEAD's commit, or `null` on a branch with no commit yet. */
  head(): Promise<string | null>;
  /** `path`'s diff in `area`, as hunks to stage or unstage one at a time
   *  (#406). Rejects when git cannot read it. */
  hunks(path: string, area: HunkArea): Promise<FileHunks>;
  /** Stage one hunk of a file's unstaged diff, or unstage one of its staged
   *  diff, as long as the diff is still the one it was shown from. */
  applyHunk(choice: HunkChoice): Promise<HunkOutcome>;
};

/**
 * The working tree of one repository as a host's screen works it (#403): its
 * status, whole-file stage and unstage, and commit or amend (#407); and in a
 * conflict (#410), marking files resolved and continuing or aborting the
 * operation. Host-neutral: the desktop host's working tree panel is today's
 * only caller.
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

  /** The status and HEAD's message, side by side: both only read. The amend
   *  basis is made of the two, the operation in progress taken from the
   *  status, so it is detected once per read. */
  const read = async (
    error: string | null,
    refused?: CommitRefusal
  ): Promise<WorkingTreeAnswer> => {
    const git = deps.git();
    const [status, message] = await Promise.allSettled([workingTreeStatus(git), headMessage(git)]);
    const unread = [status, message].find((r) => r.status === "rejected");
    return {
      status: status.status === "fulfilled" ? status.value : null,
      amend:
        status.status === "fulfilled" && message.status === "fulfilled"
          ? amendBasisOf(status.value.operation, message.value)
          : null,
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
      ),
    resolve: (paths) => mutate((git) => resolveFiles(git, paths)),
    continueOperation: () => mutate(continueOperation),
    abortOperation: () => mutate(abortOperation),
    // Reads for the diff viewer, not in turn with the rest: neither changes
    // anything, and each is one git run of its own (`spawnGit`), so a diff
    // shown after a hunk is not held up behind the panel's status read, nor
    // that behind the graph's reload on the same git client. What a read
    // racing a change sees is caught by the diff's token, and by the reads
    // around the diff's text (`createShowDiff`).
    head: () => readHead(deps.diffRun()),
    hunks: async (path, area) => offeredHunks(await readFileDiff(deps.diffRun(), path, area)),
    // The patch is made outside the mutation: a hunk refused for a diff that
    // changed, or has none of its own, is no change — the watcher is not
    // muted for it, nor the graph refreshed after it.
    applyHunk: (choice) =>
      inTurn(async (): Promise<HunkOutcome> => {
        // One repository throughout: the one the diff was checked in is the
        // one the patch goes to.
        const run = deps.diffRun();
        try {
          const checked = await hunkPatch(run, choice);
          // Checked again inside, just before git writes: the diff may have
          // moved since, and `git apply` could find the hunk's context at
          // an offset rather than refuse it.
          let applied = checked;
          await deps.runRepoMutation(deps.repo(), async () => {
            applied = await hunkPatch(run, choice);
            await applyHunkPatch(run, applied);
          });
          return { kind: "applied", hunk: applied.hunk };
        } catch (e: unknown) {
          if (e instanceof StaleHunkError) return { kind: "stale" };
          if (e instanceof NoHunkError) return { kind: "none", reason: e.reason };
          return { kind: "failed", error: formatGitError(e) };
        }
      })
  };
}
