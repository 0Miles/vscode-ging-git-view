import type { SimpleGit } from "simple-git";

import { resetToCommit } from "@/backend/actions/commit";
import type {
  ActionPayload,
  ActionResponseExtra,
  BatchActionPayload,
  BatchDeleteResult,
  BatchPushResult,
  BatchRefResult
} from "@/backend/types";
import { REMOTE_PREFIX, splitRemoteRef } from "@/backend/utils/branchRef";
import {
  formatGitError,
  isNotFullyMergedError,
  isRemoteUpdatedSinceCheckoutError,
  isStaleLeaseInfoError,
  LabelledGitErrors
} from "@/backend/utils/gitError";

export async function createBranch(
  git: SimpleGit,
  input: ActionPayload<"createBranch">
): Promise<void> {
  if (input.checkout) {
    // -B resets an existing branch to the commit (replace); -b fails if it exists.
    await git.raw(["checkout", input.force ? "-B" : "-b", input.branchName, input.commitHash]);
  } else {
    const args = ["branch"];
    if (input.force) args.push("-f");
    args.push(input.branchName, input.commitHash);
    await git.raw(args);
  }
}

/** Delete `branchName` on every one of `remotes` that actually carries it. */
async function deleteOnRemotes(
  git: SimpleGit,
  branchName: string,
  remotes: readonly string[]
): Promise<void> {
  await Promise.all(
    remotes.map(async (remote) => {
      const refs = await git.raw(["ls-remote", "--heads", remote, branchName]);
      if (refs.trim() !== "") {
        await git.raw(["push", remote, "--delete", branchName]);
      }
    })
  );
}

export async function deleteBranch(
  git: SimpleGit,
  input: ActionPayload<"deleteBranch">
): Promise<void> {
  await git.deleteLocalBranch(input.branchName, input.forceDelete);
  if (input.deleteOnRemotes) {
    const remotes = (await git.getRemotes()).map((r) => r.name);
    await deleteOnRemotes(git, input.branchName, remotes);
  }
}

/**
 * Run `attempt` over `refs` one at a time, reporting each ref's fate.
 *
 * Sequential on purpose: these all mutate refs in one repo, so running them
 * concurrently buys no wall-clock and only adds lock contention. Every ref is
 * attempted even after an earlier one fails — the operations are independent,
 * and stopping halfway would leave a partly-done job with no way to see where
 * it stopped.
 */
async function mapRefsSequentially(
  refs: readonly string[],
  attempt: (ref: string) => Promise<void>
): Promise<BatchRefResult[]> {
  const results: BatchRefResult[] = [];
  for (const ref of refs) {
    try {
      await attempt(ref); // eslint-disable-line no-await-in-loop -- see above
      results.push({ ref, status: null });
    } catch (e: unknown) {
      results.push({ ref, status: formatGitError(e) });
    }
  }
  return results;
}

/** The two git operations a batch deletion splits into. */
export type BranchDeletionPlan = {
  /** Local branches, deleted with `git branch -d/-D`. */
  local: string[];
  /** Remote-tracking refs, deleted on their own remote. */
  remote: string[];
};

/** Split a batch of refs by which of the two deletions each one needs. */
export function planBranchDeletion(refs: readonly string[]): BranchDeletionPlan {
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of refs) (ref.startsWith(REMOTE_PREFIX) ? remote : local).push(ref);
  return { local, remote };
}

/**
 * Delete several branches, reporting each one's fate.
 *
 * With `deleteOnRemotes` a local deletion already pushes `--delete <name>` to
 * every remote carrying that name, so a remote-tracking ref for a name that was
 * *successfully* deleted locally is reported as done rather than pushed again —
 * the second attempt would fail with "remote ref does not exist" (survivable,
 * since {@link deleteRemoteBranch} turns that into a prune, but a wasted round
 * trip per remote). The skip is keyed on success, not on selection: when the
 * local delete fails, nothing covered the remote ref and it still needs its own
 * deletion.
 */
export async function deleteBranches(
  git: SimpleGit,
  input: BatchActionPayload<"deleteBranches">
): Promise<BatchDeleteResult[]> {
  const plan = planBranchDeletion(input.refs);
  // One remote lookup for the whole batch. The single-branch path pays it per
  // call, which across N branches would be N extra git spawns before any of the
  // `ls-remote` round trips they gate.
  const remotes = input.deleteOnRemotes ? (await git.getRemotes()).map((r) => r.name) : [];
  const notFullyMerged = new Set<string>();
  const localResults = await mapRefsSequentially(plan.local, async (branchName) => {
    try {
      await git.deleteLocalBranch(branchName, input.forceDelete);
    } catch (e: unknown) {
      if (isNotFullyMergedError(e)) notFullyMerged.add(branchName);
      throw e;
    }
    await deleteOnRemotes(git, branchName, remotes);
  });
  const deletedNames = new Set(localResults.filter((r) => r.status === null).map((r) => r.ref));
  const remoteResults = await mapRefsSequentially(plan.remote, async (ref) => {
    const parts = splitRemoteRef(ref);
    if (parts === null) {
      // Only reachable for a local branch literally named `remotes/x`, which the
      // branch-list format cannot tell apart from a remote-tracking ref (see
      // branchRef.ts). Statuses carry raw git output rather than localized copy,
      // so an English line here is consistent with the rest.
      throw new Error(`not a remote-tracking ref: ${ref}`);
    }
    if (input.deleteOnRemotes && deletedNames.has(parts.name)) return; // already gone
    await deleteRemoteBranch(git, { remote: parts.remote, branchName: parts.name });
  });
  return [...localResults, ...remoteResults].map((r) => ({
    ref: r.ref,
    status: r.status,
    notFullyMerged: notFullyMerged.has(r.ref)
  }));
}

/** Push several branches to the same remotes with the same force mode. Each
 *  refusal keeps git's own line as its status; a refused lease is also
 *  classified, so the summary can explain it. */
export async function pushBranches(
  git: SimpleGit,
  input: BatchActionPayload<"pushBranches">
): Promise<BatchPushResult[]> {
  const refusals = new Map<string, PushRefusalFacts>();
  const results = await mapRefsSequentially(input.branchNames, async (branchName) => {
    try {
      await pushBranch(git, { branchName, remotes: input.remotes, forceMode: input.forceMode });
    } catch (e: unknown) {
      refusals.set(branchName, pushRefusalFacts(e));
      throw e;
    }
  });
  return results.map((r) => {
    const facts = refusals.get(r.ref) ?? pushRefusalFacts(null);
    return {
      ref: r.ref,
      status: r.status,
      remoteUpdatedSinceCheckout: facts.remoteUpdatedSinceCheckout,
      staleInfoRefs: facts.staleInfoRefs
    };
  });
}

/** Fast-forward several branches to their own upstreams. */
export function fastForwardBranches(
  git: SimpleGit,
  input: BatchActionPayload<"fastForwardBranches">
): Promise<BatchRefResult[]> {
  return mapRefsSequentially(input.branchNames, (branchName) =>
    fastForwardBranch(git, { branchName })
  );
}

export async function pullBranch(
  git: SimpleGit,
  input: ActionPayload<"pullBranch">
): Promise<void> {
  await git.pull(input.remote, input.branchName);
}

/** The `git` arguments that push `branch` to `remote` in `forceMode`. Raw
 *  arguments rather than simple-git's `git.push`, which appends `--porcelain`
 *  and so turns a rejection into a line nobody can read. */
function pushArgs(
  remote: string,
  branch: string,
  forceMode: ActionPayload<"pushBranch">["forceMode"]
): string[] {
  switch (forceMode) {
    case "normal":
      return ["push", remote, branch];
    case "force":
      return ["push", "--force", remote, branch];
    case "forceWithLease":
      // The lease only holds if the remote tip was integrated, not just fetched;
      // `-c`, not `--force-if-includes`, so git < 2.30 still pushes. See ADR-0025.
      return ["-c", "push.useForceIfIncludes=true", "push", "--force-with-lease", remote, branch];
  }
}

/** A push one remote refused, tagged with the tracking ref it pushed against.
 *  git's own output names the remote only by URL ("To <url>"), and once
 *  several remotes are pushed in parallel nothing else says which one refused.
 *  The message is git's, unchanged, so `formatGitError` and the classifiers in
 *  `gitError` read it exactly as before. */
class RemotePushError extends Error {
  constructor(
    readonly trackingRef: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The tracking refs (`<remote>/<branch>`) a force-with-lease push was refused
 *  for with "(stale info)", one per remote that refused that way, in the order
 *  the remotes were given. Empty for any other failure. See
 *  `isStaleLeaseInfoError`. */
export function staleLeaseInfoRefs(error: unknown): string[] {
  const failures =
    error instanceof LabelledGitErrors ? error.failures.map((f) => f.error) : [error];
  return failures.flatMap((e) =>
    e instanceof RemotePushError && isStaleLeaseInfoError(e) ? [e.trackingRef] : []
  );
}

type PushRefusalFacts = ActionResponseExtra<"pushBranch">;

/** What a push reports beside its status, read off the raw error `pushBranch`
 *  threw (null when it succeeded). The single push and each ref of a batch
 *  push report the same facts, so both read them here. */
export function pushRefusalFacts(error: unknown): PushRefusalFacts {
  return {
    remoteUpdatedSinceCheckout: isRemoteUpdatedSinceCheckoutError(error),
    staleInfoRefs: staleLeaseInfoRefs(error)
  };
}

/** Push to each selected remote; simple-git serialises them internally. Every
 *  remote is pushed and heard from before this settles (#264). A lone refusal
 *  is thrown as it is, so one remote reads as it always has; several are
 *  thrown together, each under its remote's name, since git's own output names
 *  a remote only by URL. */
export async function pushBranch(
  git: SimpleGit,
  input: ActionPayload<"pushBranch">
): Promise<void> {
  const outcomes = await Promise.allSettled(
    input.remotes.map((remote) =>
      git.raw(pushArgs(remote, input.branchName, input.forceMode)).catch((e: unknown) => {
        throw new RemotePushError(`${remote}/${input.branchName}`, e);
      })
    )
  );
  const failures = outcomes.flatMap((outcome, i) =>
    outcome.status === "rejected" ? [{ label: input.remotes[i], error: outcome.reason }] : []
  );
  if (failures.length === 1) throw failures[0].error;
  if (failures.length > 1) throw new LabelledGitErrors(failures);
}

export async function deleteRemoteBranch(
  git: SimpleGit,
  input: ActionPayload<"deleteRemoteBranch">
): Promise<void> {
  try {
    await git.raw(["push", input.remote, "--delete", input.branchName]);
  } catch (e: unknown) {
    // The branch is already gone on the remote (e.g. deleted by a merged-PR
    // auto-delete or another client), but a stale local remote-tracking ref
    // still shows it in the graph — and `push --delete` fails with "remote ref
    // does not exist". The user's intent is to make the label disappear, so
    // prune that tracking ref instead of surfacing the error.
    const message = e instanceof Error ? e.message : String(e);
    if (/remote ref does not exist/i.test(message)) {
      await git.raw(["branch", "-d", "-r", `${input.remote}/${input.branchName}`]);
      return;
    }
    throw e;
  }
}

export async function fetchIntoLocalBranch(
  git: SimpleGit,
  input: ActionPayload<"fetchIntoLocalBranch">
): Promise<void> {
  const args = ["fetch"];
  if (input.force) args.push("--force");
  args.push(input.remote, `${input.remoteBranch}:${input.localBranch}`);
  await git.raw(args);
}

export async function renameBranch(
  git: SimpleGit,
  input: ActionPayload<"renameBranch">
): Promise<void> {
  await git.raw(["branch", "-m", input.oldName, input.newName]);
}

/** Point a local branch at another commit — what dropping its label on a
 *  commit row asks for (#208). Any branch but the checked-out one moves with
 *  `branch -f`, which git refuses for a branch checked out in another worktree.
 *
 *  The webview sends the checked-out branch to Reset instead, but HEAD is read
 *  again here, as the command runs: if it changed since the webview looked,
 *  the dragged branch is the checked-out one now, and it moves with
 *  `reset --keep`, which keeps uncommitted changes and refuses to overwrite
 *  one. Taking HEAD from the webview would instead reset whichever branch
 *  really is checked out — a different branch than the one the user dragged. */
export async function moveBranch(
  git: SimpleGit,
  input: ActionPayload<"moveBranch">
): Promise<void> {
  // `--symbolic-full-name` answers `HEAD` itself when detached, never failing.
  const head = (await git.raw(["rev-parse", "--symbolic-full-name", "HEAD"])).trim();
  if (head === "refs/heads/" + input.branchName) {
    await resetToCommit(git, { commitHash: input.commitHash, resetMode: "keep" });
  } else {
    await git.raw(["branch", "-f", input.branchName, input.commitHash]);
  }
}

/** Fast-forward a (non-checked-out) local branch up to its configured upstream
 *  without switching to it. `git fetch .` refuses a non-fast-forward update, so
 *  this can never rewrite or lose history; it errors if the branch has no
 *  upstream or is the current branch (git won't fetch into a checked-out ref). */
export async function fastForwardBranch(
  git: SimpleGit,
  input: ActionPayload<"fastForwardBranch">
): Promise<void> {
  const upstream = (
    await git.raw([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${input.branchName}@{upstream}`
    ])
  ).trim();
  await git.raw(["fetch", ".", `${upstream}:${input.branchName}`]);
}

export async function checkoutBranch(
  git: SimpleGit,
  input: ActionPayload<"checkoutBranch">
): Promise<void> {
  if (input.remoteBranch === null) {
    await git.checkout(input.branchName);
  } else if (input.force) {
    // -B resets an existing (divergent) local branch to the remote and checks it
    // out, discarding any local-only commits; it sets up tracking just like -b.
    await git.raw(["checkout", "-B", input.branchName, input.remoteBranch]);
  } else {
    await git.checkoutBranch(input.branchName, input.remoteBranch);
  }
}
