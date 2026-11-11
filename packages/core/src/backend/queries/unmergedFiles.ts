import type { SimpleGit } from "simple-git";

/** The working tree's unmerged paths — both-modified, added/added and the
 *  like — repository-relative, unquoted. Rejects when git cannot be asked. */
export async function unmergedFiles(git: SimpleGit): Promise<string[]> {
  const out = await git.raw([
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-only",
    "--diff-filter=U"
  ]);
  return out.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
}
