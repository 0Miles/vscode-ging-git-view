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
