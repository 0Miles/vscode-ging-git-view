import * as fs from "node:fs";
import * as path from "node:path";

import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

/** Message format for the commit created after a `--squash` merge.
 *  "Default" = GING's generated `Merge branch 'X'`; "Git SQUASH_MSG" = the
 *  detailed message Git prepares in `.git/SQUASH_MSG` (the list of squashed
 *  commits). */
export type SquashMessageFormat = "Default" | "Git SQUASH_MSG";

/** After a `--squash` merge, the changes are staged but not committed, so commit
 *  them. Gate on the `SQUASH_MSG` file, which git writes only when the squash
 *  actually staged merge content: this skips the commit on an up-to-date / no-op
 *  merge, and — unlike checking the index — never absorbs changes the user had
 *  staged before triggering the merge. */
async function commitSquashedMerge(
  git: SimpleGit,
  actionOn: "branch" | "commit",
  obj: string,
  format: SquashMessageFormat,
  signCommits: boolean
) {
  const gitDir = (await git.raw(["rev-parse", "--absolute-git-dir"])).trim();
  const squashMsgPath = path.join(gitDir, "SQUASH_MSG");
  if (fs.existsSync(squashMsgPath)) {
    const sign = signCommits ? ["-S"] : []; // GPG/SSH-sign the squash commit
    await git.raw(
      format === "Git SQUASH_MSG"
        ? ["commit", ...sign, "-F", squashMsgPath]
        : ["commit", ...sign, "-m", `Merge ${actionOn} '${obj}'`]
    );
  }
}

/** Build `git merge` args. `--squash` already implies no auto-commit, so
 *  `--no-commit` is only added for non-squash merges to avoid combining them. */
function mergeArgs(
  obj: string,
  createNewCommit: boolean,
  squash: boolean,
  noCommit: boolean,
  signCommits: boolean
) {
  const args = [obj];
  if (squash) {
    args.push("--squash");
  } else {
    if (createNewCommit) args.push("--no-ff");
    if (noCommit) args.push("--no-commit");
    if (signCommits) args.push("-S"); // sign the merge commit
  }
  return args;
}

export async function mergeBranch(
  git: SimpleGit,
  input: ActionPayload<"mergeBranch">,
  squashMessageFormat: SquashMessageFormat = "Default",
  signCommits: boolean = false
): Promise<void> {
  await git.merge(
    mergeArgs(input.branchName, input.createNewCommit, input.squash, input.noCommit, signCommits)
  );
  // A squashed merge leaves changes staged; commit them unless the user asked
  // not to (No Commit), so they can review/amend the squash first.
  if (input.squash && !input.noCommit) {
    await commitSquashedMerge(git, "branch", input.branchName, squashMessageFormat, signCommits);
  }
}

export async function mergeCommit(
  git: SimpleGit,
  input: ActionPayload<"mergeCommit">,
  squashMessageFormat: SquashMessageFormat = "Default",
  signCommits: boolean = false
): Promise<void> {
  await git.merge(
    mergeArgs(input.commitHash, input.createNewCommit, input.squash, input.noCommit, signCommits)
  );
  if (input.squash && !input.noCommit) {
    await commitSquashedMerge(git, "commit", input.commitHash, squashMessageFormat, signCommits);
  }
}
