import type { SimpleGit } from "simple-git";

const eolRegex = /\r\n|\r|\n/;

/**
 * Detect whether a file known at `commitHash` has since been renamed in the
 * working tree, and return its current path. Runs a rename-only diff
 * between the commit and the working tree; returns null when the file wasn't
 * renamed or the command fails.
 */
export async function getNewPathOfRenamedFile(
  git: SimpleGit,
  commitHash: string,
  oldFilePath: string
): Promise<string | null> {
  try {
    const stdout = await git.raw([
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-status",
      "--find-renames",
      "--diff-filter=R",
      commitHash
    ]);
    for (const line of stdout.split(eolRegex)) {
      // Rename records are "R<score>\t<oldPath>\t<newPath>".
      const parts = line.split("\t");
      if (parts.length === 3 && parts[0].startsWith("R") && parts[1] === oldFilePath) {
        return parts[2];
      }
    }
  } catch {
    // Diff failed (e.g. invalid commit); treat as "not renamed".
  }
  return null;
}
