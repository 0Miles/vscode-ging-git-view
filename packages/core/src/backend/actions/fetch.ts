import type { SimpleGit } from "simple-git";

export type FetchInput = { prune: boolean; pruneTags: boolean };

/** The argv of a fetch from all remotes. */
export function fetchAllArgs(input: FetchInput): string[] {
  const args = ["fetch", "--all"];
  if (input.prune) args.push("--prune");
  if (input.prune && input.pruneTags) args.push("--prune-tags");
  return args;
}

/** The argv of a fetch from one named remote. */
export function fetchRemoteArgs(input: FetchInput & { remote: string }): string[] {
  const args = ["fetch"];
  if (input.prune) args.push("--prune");
  if (input.prune && input.pruneTags) args.push("--prune-tags");
  // `--`: a remote named like an option (`--upload-pack=<cmd>`) is a name, not
  // an option — run outside a git client, nothing else would refuse it.
  args.push("--", input.remote);
  return args;
}

/** Fetch from all remotes, optionally pruning deleted remote-tracking branches
 *  (and tags). Mirrors the control bar's "Fetch" button. */
export async function fetchFromRemotes(git: SimpleGit, input: FetchInput): Promise<void> {
  await git.raw(fetchAllArgs(input));
}

/** Fetch from a single named remote, with the same pruning options. */
export async function fetchRemote(
  git: SimpleGit,
  input: FetchInput & { remote: string }
): Promise<void> {
  await git.raw(fetchRemoteArgs(input));
}
