import type { SimpleGit } from "simple-git";

export type GraphStash = {
  hash: string;
  baseHash: string | null;
  selector: string; // e.g. "stash@{0}"
  message: string;
  date: number;
};

const eolRegex = /\r\n|\r|\n/g;
const sep = "XX7Nal-YARtTpjCikii9nJxER19D6diSyk-Stash";

/**
 * List the repository's stashes as graph-displayable entries. Each stash is a
 * commit whose first parent is the commit it was created on (its base); the
 * other parents (index/untracked trees) are ignored for graph purposes.
 */
export async function loadStashes(git: SimpleGit): Promise<GraphStash[]> {
  try {
    const stdout = await git.raw([
      "stash",
      "list",
      `--format=%H${sep}%P${sep}%ct${sep}%gd${sep}%s`
    ]);
    const stashes: GraphStash[] = [];
    const lines = stdout.split(eolRegex);
    for (const line of lines) {
      if (line === "") continue;
      const parts = line.split(sep);
      if (parts.length < 5) continue;
      const parents = parts[1] === "" ? [] : parts[1].split(" ");
      const date = parseInt(parts[2], 10);
      stashes.push({
        hash: parts[0],
        baseHash: parents.length > 0 ? parents[0] : null,
        selector: parts[3],
        message: parts.slice(4).join(sep),
        date: Number.isNaN(date) ? 0 : date
      });
    }
    return stashes;
  } catch {
    return [];
  }
}
