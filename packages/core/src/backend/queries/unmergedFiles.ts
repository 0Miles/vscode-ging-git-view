import type { SimpleGit } from "simple-git";

import { NO_INDEX_REFRESH } from "@ging/core/backend/gitSpawn";

/** The working tree's unmerged paths — both-modified, added/added and the
 *  like — repository-relative, unquoted. Rejects when git cannot be asked.
 *  Never writes the index: the graph asks this while the user may be writing
 *  (#451). */
export async function unmergedFiles(git: SimpleGit): Promise<string[]> {
  const out = await git.raw([
    ...NO_INDEX_REFRESH,
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-only",
    "--diff-filter=U"
  ]);
  return out.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
}
