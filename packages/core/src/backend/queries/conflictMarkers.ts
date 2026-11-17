import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A line git's merge writes around each side of a conflict: `<<<<<<<` before
 *  ours, `|||||||` before the base (diff3), `>>>>>>>` after theirs, each
 *  followed by a label or nothing. The `=======` between the sides is left
 *  out: a line of seven `=` is a heading underline in Markdown and
 *  reStructuredText, and is never the only marker left. */
const MARKER = /^(?:<{7}|\|{7}|>{7})(?: |\r?$)/m;

/** How much of a file is looked at: a conflict in anything bigger is past
 *  what a person resolves by hand, and reading all of a huge file to ask one
 *  question would hold the answer up. */
export const MARKER_SCAN_BYTES = 8 * 1024 * 1024;
/** Where git looks for a NUL to call a file binary; git writes no markers
 *  into a binary file, it keeps one side whole. */
const BINARY_PROBE_BYTES = 8000;

/** Whether the start of `full`, up to `MARKER_SCAN_BYTES`, holds a marker. */
async function holdsMarker(full: string): Promise<boolean> {
  const file = await fs.open(full, "r");
  try {
    const length = Math.min((await file.stat()).size, MARKER_SCAN_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.subarray(0, BINARY_PROBE_BYTES).includes(0)) return false;
    return MARKER.test(head.toString("utf8"));
  } finally {
    await file.close();
  }
}

/**
 * Which of `paths`, repository-relative, still hold a conflict marker in the
 * working tree of `repoRoot`. A path that is not there (the side that deleted
 * it won) holds none; one that leads out of the repository is not read; a
 * binary file (a NUL early on, as git tells them) holds none, and only the
 * first `MARKER_SCAN_BYTES` of a file are read. Markers of another size
 * (`conflict-marker-size`) are not looked for.
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
        return await holdsMarker(full);
      } catch {
        // Gone, a folder, or unreadable: nothing to warn of.
        return false;
      }
    })
  );
  return paths.filter((_, i) => marked[i]);
}
