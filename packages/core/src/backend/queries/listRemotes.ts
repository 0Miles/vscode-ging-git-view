import type { SimpleGit } from "simple-git";

/** One configured remote, as the Remotes side view lists it. */
export type ConfiguredRemote = {
  name: string;
  /** "" when git reports none. */
  fetchUrl: string;
  /** The fetch URL, unless a push URL of its own is set; "" when git reports
   *  none. */
  pushUrl: string;
};

/** Every configured remote of the repo `git` is bound to, with its URLs, in
 *  git's order. Rejects when git cannot read the repo. */
export async function listRemotes(git: SimpleGit): Promise<ConfiguredRemote[]> {
  return (await git.getRemotes(true)).map((remote) => ({
    name: remote.name,
    fetchUrl: remote.refs.fetch ?? "",
    pushUrl: remote.refs.push ?? ""
  }));
}
