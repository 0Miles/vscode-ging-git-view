import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

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
    await git.push(input.pushToRemote, input.tagName, input.force ? ["--force"] : []);
  }
}

export async function deleteTag(git: SimpleGit, input: ActionPayload<"deleteTag">): Promise<void> {
  await git.tag(["-d", input.tagName]);
  if (input.deleteOnRemote !== null) {
    await git.push(input.deleteOnRemote, ":refs/tags/" + input.tagName);
  }
}

export async function pushTag(git: SimpleGit, input: ActionPayload<"pushTag">): Promise<void> {
  // Push the tag to each selected remote; simple-git serialises them.
  await Promise.all(input.remotes.map((remote) => git.push(remote, input.tagName)));
}
