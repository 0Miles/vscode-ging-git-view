import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A line git's merge writes around each side of a conflict: `<<<<<<<` before
 *  ours, `|||||||` before the base (diff3), `>>>>>>>` after theirs, each
 *  followed by a label or nothing. The `=======` between the sides is left
 *  out: a line of seven `=` is a heading underline in Markdown and
 *  reStructuredText, and is never the only marker left. */
const MARKER = /^(?:<{7}|\|{7}|>{7})(?: |\r?$)/m;

/**
 * Which of `paths`, repository-relative, still hold a conflict marker in the
 * working tree of `repoRoot`. A path that is not there (the side that deleted
 * it won) holds none; one that leads out of the repository is not read.
 * Markers of another size (`conflict-marker-size`) are not looked for.
 */
export async function filesWithConflictMarkers(
  repoRoot: string,
  paths: readonly string[]
): Promise<string[]> {
  const root = path.resolve(repoRoot);
  const marked = await Promise.all(
    paths.map(async (file) => {
      const full = path.resolve(root, file);
      const relative = path.relative(root, full);
      const outside =
        relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
      if (relative === "" || outside) return false;
      try {
        return MARKER.test(await fs.readFile(full, "utf8"));
      } catch {
        // Gone, a folder, or unreadable: nothing to warn of.
        return false;
      }
    })
  );
  return paths.filter((_, i) => marked[i]);
}
