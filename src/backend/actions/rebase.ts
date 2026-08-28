import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

/** Rebase the currently checked-out branch onto `obj` (a branch name or commit
 *  hash). On conflict git stops mid-rebase and the error is surfaced. */
export async function rebaseOn(
  git: SimpleGit,
  input: ActionPayload<"rebaseOn">,
  signCommits: boolean = false
): Promise<void> {
  // `-S` GPG/SSH-signs the rebased commits.
  await git.rebase(signCommits ? ["-S", input.obj] : [input.obj]);
}

/**
 * Replay the commits in `upstream..tip` onto `newBase` — `git rebase --onto`.
 *
 * `upstream` is the exclusive lower bound of the range, so it must be the
 * ancestor of the two commits the caller selected; the webview resolves that
 * order before sending. `tip` is spelled as a branch name whenever one points
 * at that commit, which is what makes git move the branch; given a raw hash git
 * leaves HEAD detached at the replayed tip instead.
 */
export async function rebaseOnto(
  git: SimpleGit,
  input: ActionPayload<"rebaseOnto">,
  signCommits: boolean = false
): Promise<void> {
  const args = ["rebase"];
  if (signCommits) args.push("-S"); // GPG/SSH-sign the replayed commits
  args.push("--onto", input.newBase, input.upstream, input.tip);
  await git.raw(args);
}
