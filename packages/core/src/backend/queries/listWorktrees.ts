import type { SimpleGit } from "simple-git";

import type { WorktreeEntry } from "@/backend/types";

const eolRegex = /\r?\n/;
const headsPrefix = "refs/heads/";

/**
 * Parse the output of `git worktree list --porcelain` into ordered entries.
 *
 * Records are separated by a blank line; each line is an attribute. The first
 * record is always the main worktree. Exported separately from the git call so
 * it can be unit-tested against captured fixtures without spawning git.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  // Records are separated by a blank line; each record opens with `worktree <path>`.
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(eolRegex).filter((line) => line !== "");
    const head = lines.find((line) => line.startsWith("worktree "));
    if (!head) continue;
    const entry: WorktreeEntry = {
      path: head.slice("worktree ".length),
      branch: null,
      detached: false,
      bare: false,
      locked: false
    };
    for (const line of lines) {
      if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        entry.branch = ref.startsWith(headsPrefix) ? ref.slice(headsPrefix.length) : ref;
      } else if (line === "detached") {
        entry.detached = true;
      } else if (line === "bare") {
        entry.bare = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        entry.locked = true;
      }
      // `HEAD <sha>` and `prunable ...` carry nothing the sidebar needs — ignored.
    }
    entries.push(entry);
  }
  return entries;
}

export async function listWorktrees(git: SimpleGit): Promise<WorktreeEntry[]> {
  try {
    const stdout = await git.raw(["worktree", "list", "--porcelain"]);
    return parseWorktreeList(stdout);
  } catch {
    return [];
  }
}
