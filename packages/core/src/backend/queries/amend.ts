import type { SimpleGit } from "simple-git";

import { detectOperation } from "@ging/core/backend/queries/operationState";
import type { AmendBasis, GitOperation } from "@ging/shared/backend/types";

/**
 * The remote-tracking branches HEAD is on, by short name (`origin/main`):
 * what `git branch -r --contains HEAD` lists, read in a form made for reading
 * (#407). A remote's `HEAD`, a symbolic ref to one of its branches, is left
 * out: the branch it points at is listed in its own right. None on a branch
 * with no commit yet.
 *
 * As fresh as the last fetch: a branch pushed from elsewhere since is not
 * known here, and one deleted on the remote stays until a pruning fetch.
 */
export async function remoteBranchesContainingHead(git: SimpleGit): Promise<string[]> {
  if ((await headCommit(git)) === "") return [];
  const out = await git.raw([
    "for-each-ref",
    "--contains=HEAD",
    "--format=%(refname:short)%00%(symref)",
    "refs/remotes/"
  ]);
  return out
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([name, symref]) => name !== "" && (symref ?? "") === "")
    .map(([name]) => name);
}

/**
 * What an amend of HEAD would start from: HEAD's message as written, or why
 * HEAD cannot be amended — there is no commit yet, or a merge, rebase,
 * cherry-pick or revert is in progress, whose work an amend would fold into
 * the commit before it (#407). Git itself refuses only some of these; GING
 * refuses them all, a rebase's `edit` stop included.
 */
export async function amendBasis(git: SimpleGit): Promise<AmendBasis> {
  const [operation, message] = await Promise.all([detectOperation(git), headMessage(git)]);
  return amendBasisOf(operation, message);
}

/**
 * `amendBasis` from what is already read: the operation in progress, as a
 * status read finds it (`WorkingTreeStatus.operation`), and HEAD's message
 * (`headMessage`). For a caller reading the status anyway, so the operation
 * is detected once per read.
 */
export function amendBasisOf(
  operation: GitOperation | null | undefined,
  message: string | null
): AmendBasis {
  if (operation !== null && operation !== undefined) return { possible: false, reason: operation };
  if (message === null) return { possible: false, reason: "unborn" };
  return { possible: true, message };
}

/** HEAD's message without the newline `%B` ends on, or null with no HEAD. */
export async function headMessage(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.raw(["log", "-1", "--format=%B", "HEAD"])).replace(/\n+$/, "");
  } catch (e: unknown) {
    // Asked only once it failed, which on a branch with no commit it does:
    // read with every status, the common case is one spawn.
    if ((await headCommit(git)) === "") return null;
    throw e;
  }
}

/** HEAD's commit, or "" on a branch with none yet. */
export async function headCommit(git: SimpleGit): Promise<string> {
  // `--verify -q` fails quietly on an unborn branch, which simple-git
  // resolves with the empty output.
  return (await git.raw(["rev-parse", "--verify", "-q", "HEAD"])).trim();
}
