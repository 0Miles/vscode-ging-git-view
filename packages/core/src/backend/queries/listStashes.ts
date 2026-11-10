import type { SimpleGit } from "simple-git";

import type { ScmStashEntry } from "@ging/shared/backend/types";

const eolRegex = /\r?\n/;

export async function listStashes(git: SimpleGit): Promise<ScmStashEntry[]> {
  try {
    // `%H` is the stash commit's SHA, `%gd` the selector (e.g. stash@{0}), `%ct`
    // committer date as unix ts, `%s` subject: the same subject the graph labels
    // the stash with (`loadStashes`).
    const stdout = await git.raw(["stash", "list", "--format=%H%x09%gd%x09%ct%x09%s"]);
    if (!stdout.trim()) return [];
    const stashes: ScmStashEntry[] = [];
    const lines = stdout.split(eolRegex);
    let position = 0;
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const ts = parseInt(parts[2], 10);
      stashes.push({
        hash: parts[0],
        ref: parts[1],
        index: position,
        message: parts.slice(3).join("\t"),
        date: Number.isNaN(ts) ? null : ts
      });
      position++;
    }
    return stashes;
  } catch {
    return [];
  }
}
