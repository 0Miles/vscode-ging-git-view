import type { SimpleGit } from "simple-git";

export type FetchInput = { prune: boolean; pruneTags: boolean };

/** Fetch from all remotes, optionally pruning deleted remote-tracking branches
 *  (and tags). Mirrors the control bar's "Fetch" button. */
export async function fetchFromRemotes(git: SimpleGit, input: FetchInput): Promise<void> {
  const args = ["fetch", "--all"];
  if (input.prune) args.push("--prune");
  if (input.prune && input.pruneTags) args.push("--prune-tags");
  await git.raw(args);
}

/** Fetch from a single named remote, with the same pruning options. */
export async function fetchRemote(
  git: SimpleGit,
  input: FetchInput & { remote: string }
): Promise<void> {
  const args = ["fetch"];
  if (input.prune) args.push("--prune");
  if (input.prune && input.pruneTags) args.push("--prune-tags");
  args.push(input.remote);
  await git.raw(args);
}

/** List the names of the repository's configured remotes. */
export async function listRemoteNames(git: SimpleGit): Promise<string[]> {
  return (await git.getRemotes()).map((r) => r.name);
}
