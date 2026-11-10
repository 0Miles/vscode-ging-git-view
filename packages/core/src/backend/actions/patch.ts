import * as fs from "node:fs";
import * as path from "node:path";

import type { SimpleGit } from "simple-git";

export type ExportPatchInput = { commitHash: string; outputPath: string };

/** Write `commitHash` as a `git format-patch` file to `outputPath`.
 *
 *  We let git write the file itself (`-o <dir>`) rather than capturing
 *  `--stdout`: simple-git decodes stdout as UTF-8 into a string, which would
 *  corrupt any non-UTF-8 bytes in the diff. git writes into the destination's
 *  own directory under its generated name, which we then rename to the exact
 *  name the user chose — a same-filesystem rename, so it stays atomic and
 *  byte-exact. */
export async function exportPatch(git: SimpleGit, input: ExportPatchInput): Promise<void> {
  const outDir = path.dirname(input.outputPath);
  // `-1` writes exactly one file; git prints its path (trailing newline only).
  const generated = (await git.raw(["format-patch", "-1", "-o", outDir, input.commitHash])).trim();
  if (generated === "") {
    throw new Error("git format-patch produced no output file");
  }
  if (path.resolve(generated) !== path.resolve(input.outputPath)) {
    await fs.promises.rename(generated, input.outputPath);
  }
}
