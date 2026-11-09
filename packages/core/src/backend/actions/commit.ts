import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

export async function checkoutCommit(
  git: SimpleGit,
  input: ActionPayload<"checkoutCommit">
): Promise<void> {
  await git.checkout(input.commitHash);
}

export async function cherrypickCommit(
  git: SimpleGit,
  input: ActionPayload<"cherrypickCommit">,
  signCommits: boolean = false
): Promise<void> {
  const args = ["cherry-pick"];
  if (input.parentIndex > 0) args.push("-m", String(input.parentIndex));
  if (input.noCommit) args.push("--no-commit");
  if (input.recordOrigin) args.push("-x");
  if (signCommits) args.push("-S"); // GPG/SSH-sign the new commit
  args.push(input.commitHash);
  await git.raw(args);
}

export async function revertCommit(
  git: SimpleGit,
  input: ActionPayload<"revertCommit">,
  signCommits: boolean = false
): Promise<void> {
  const args = ["revert", "--no-edit"];
  if (input.parentIndex > 0) args.push("-m", String(input.parentIndex));
  if (signCommits) args.push("-S"); // GPG/SSH-sign the revert commit
  args.push(input.commitHash);
  await git.raw(args);
}

export async function dropCommit(
  git: SimpleGit,
  input: ActionPayload<"dropCommit">
): Promise<void> {
  // Replay the commits after `commitHash` onto its parent, dropping it. Runs
  // non-interactively (no -i), so the rebase only errors on conflicts.
  await git.raw(["rebase", "--onto", input.commitHash + "~1", input.commitHash]);
}

export async function resetFileToRevision(
  git: SimpleGit,
  input: ActionPayload<"resetFileToRevision">
): Promise<void> {
  // Restore the working-tree (and index) copy of a single file to its content
  // at the given commit. The "--" disambiguates the path from a ref.
  await git.raw(["checkout", input.commitHash, "--", input.filePath]);
}

export async function resetToCommit(
  git: SimpleGit,
  input: ActionPayload<"resetToCommit">
): Promise<void> {
  await git.raw(["reset", "--" + input.resetMode, input.commitHash]);
}
