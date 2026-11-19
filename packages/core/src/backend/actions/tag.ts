import type { SimpleGit } from "simple-git";

import { attemptOnEachRemote } from "@ging/core/backend/utils/gitError";
import type { ActionPayload } from "@ging/shared/backend/types";

export async function addTag(
  git: SimpleGit,
  input: ActionPayload<"addTag">,
  signTags: boolean = false
): Promise<void> {
  const args: string[] = [];
  if (input.force) args.push("-f");
  if (input.lightweight) {
    args.push(input.tagName);
  } else {
    // `-s` makes a signed annotated tag; otherwise a plain annotated tag.
    args.push(signTags ? "-s" : "-a", input.tagName, "-m", input.message);
  }
  args.push(input.commitHash);
  await git.tag(args);
  if (input.pushToRemote !== null) {
    // Force-push the tag too when replacing, so the remote ref is updated.
    await git.raw(["push", ...(input.force ? ["--force"] : []), input.pushToRemote, input.tagName]);
  }
}

export async function deleteTag(git: SimpleGit, input: ActionPayload<"deleteTag">): Promise<void> {
  await git.tag(["-d", input.tagName]);
  if (input.deleteOnRemote !== null) {
    await git.raw(["push", input.deleteOnRemote, ":refs/tags/" + input.tagName]);
  }
}

export async function pushTag(git: SimpleGit, input: ActionPayload<"pushTag">): Promise<void> {
  // Push the tag to each selected remote; simple-git serialises them. Every
  // remote's refusal is reported, after every remote has answered (#264).
  // `raw`, as every network command of the graph's: a host can run those
  // where it can stop them (`stoppableNetworkCommands`, #450).
  await attemptOnEachRemote(input.remotes, (remote) => git.raw(["push", remote, input.tagName]));
}
