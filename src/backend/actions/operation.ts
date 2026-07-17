import type { SimpleGit } from "simple-git";

import { detectOperation, operationState } from "@/backend/queries/operationState";
import type { ActionPayload, GitOperation } from "@/backend/types";

/** The git subcommand that owns `--continue` / `--abort` for each operation. */
function operationCommand(operation: GitOperation): string {
  return operation === "cherrypick" ? "cherry-pick" : operation;
}

/** Continue the in-progress operation. No-op if nothing is in progress; fails
 *  early with a clear message if conflicts remain (rather than letting git emit
 *  its lower-level "you have unmerged files" error). The commit-message editor
 *  is a no-op for every git child (see gitClient), so this never blocks. */
export async function continueOperation(git: SimpleGit): Promise<void> {
  const { operation, conflictedFiles } = await operationState(git);
  if (operation === null) return;
  if (conflictedFiles.length > 0) {
    throw new Error(`Resolve the remaining conflicts first: ${conflictedFiles.join(", ")}`);
  }
  await git.raw([operationCommand(operation), "--continue"]);
}

/** Abort the in-progress operation, restoring the pre-operation state. No-op if
 *  nothing is in progress. */
export async function abortOperation(git: SimpleGit): Promise<void> {
  const operation = await detectOperation(git);
  if (operation === null) return;
  await git.raw([operationCommand(operation), "--abort"]);
}

/** Stage a resolved file, marking its conflict as resolved. */
export async function markResolved(
  git: SimpleGit,
  input: ActionPayload<"markResolved">
): Promise<void> {
  await git.raw(["add", "--", input.filePath]);
}
