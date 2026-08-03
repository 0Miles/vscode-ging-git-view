import type { SimpleGit } from "simple-git";

import type {
  ActionPayload,
  BatchActionPayload,
  BatchDeleteResult,
  BatchRefResult
} from "@/backend/types";
import { REMOTE_PREFIX, splitRemoteRef } from "@/backend/utils/branchRef";
import { formatGitError } from "@/backend/utils/gitError";

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

/**
 * Whether git refused a deletion only because the branch is not fully merged,
 * read off the **raw** error. The hint quotes the literal command `git branch
 * -D`, which stays in English across locales, so it is a translation-safe
 * marker — but `formatGitError` keeps only the `error:` line and drops it, so
 * this must run before the error is formatted.
 */
function isNotFullyMergedError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes("git branch -D");
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

/** Push several branches to the same remotes with the same force mode. */
export function pushBranches(
  git: SimpleGit,
  input: BatchActionPayload<"pushBranches">
): Promise<BatchRefResult[]> {
  return mapRefsSequentially(input.branchNames, (branchName) =>
    pushBranch(git, { branchName, remotes: input.remotes, forceMode: input.forceMode })
  );
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

export async function pushBranch(
  git: SimpleGit,
  input: ActionPayload<"pushBranch">
): Promise<void> {
  const opts =
    input.forceMode === "force"
      ? ["--force"]
      : input.forceMode === "forceWithLease"
        ? ["--force-with-lease"]
        : [];
  // Push to each selected remote; simple-git serialises them internally.
  await Promise.all(input.remotes.map((remote) => git.push(remote, input.branchName, opts)));
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
