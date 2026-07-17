import type { SimpleGit } from "simple-git";

import type { ScmStashEntry } from "@/backend/types";

const eolRegex = /\r?\n/;

export async function listStashes(git: SimpleGit): Promise<ScmStashEntry[]> {
  try {
    // `%gd` is the selector (e.g. stash@{0}), `%ct` committer date as unix ts, `%s` subject.
    const stdout = await git.raw(["stash", "list", "--format=%gd%x09%ct%x09%s"]);
    if (!stdout.trim()) return [];
    const stashes: ScmStashEntry[] = [];
    const lines = stdout.split(eolRegex);
    let position = 0;
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const ts = parseInt(parts[1], 10);
      stashes.push({
        ref: parts[0],
        index: position,
        message: parts.slice(2).join("\t"),
        date: Number.isNaN(ts) ? null : ts
      });
      position++;
    }
    return stashes;
  } catch {
    return [];
  }
}
