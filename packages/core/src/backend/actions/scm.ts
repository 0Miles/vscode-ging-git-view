import type { SimpleGit } from "simple-git";

export type StashPushInput = { message?: string; includeUntracked?: boolean };
export type StashRefInput = { ref: string };

export async function stashPush(git: SimpleGit, input: StashPushInput = {}): Promise<void> {
  const args = ["stash", "push"];
  if (input.includeUntracked) args.push("--include-untracked");
  if (input.message) args.push("-m", input.message);
  await git.raw(args);
}

export async function stashPop(git: SimpleGit, input: StashRefInput): Promise<void> {
  await git.raw(["stash", "pop", input.ref]);
}

export async function stashApply(git: SimpleGit, input: StashRefInput): Promise<void> {
  await git.raw(["stash", "apply", input.ref]);
}

export async function stashDrop(git: SimpleGit, input: StashRefInput): Promise<void> {
  await git.raw(["stash", "drop", input.ref]);
}
