import type { SimpleGit } from "simple-git";

import type { GitFileChange } from "@/backend/types";

import { parseDiffFileChanges } from "./diffFileChanges";

const eolRegex = /\r\n|\r|\n/g;

type CompareCommitsInput = {
  fromHash: string;
  toHash: string;
};

// `-c core.quotePath=false` keeps non-ASCII paths as raw UTF-8 (see commitDetails).
// The two-argument `diff-tree <from> <to>` form lists the changes between the two
// arbitrary commits and prints no leading commit-hash line, so parsing starts at
// line 0.
function diffArgs(fromHash: string, toHash: string, stat: "--name-status" | "--numstat"): string[] {
  return [
    "-c",
    "core.quotePath=false",
    "diff-tree",
    stat,
    "-r",
    "--find-renames",
    "--diff-filter=AMDR",
    fromHash,
    toHash
  ];
}

export async function compareCommits(
  git: SimpleGit,
  input: CompareCommitsInput
): Promise<{ fileChanges: GitFileChange[] | null }> {
  try {
    const [nameStatusLines, numStatLines] = await Promise.all([
      git
        .raw(diffArgs(input.fromHash, input.toHash, "--name-status"))
        .then((o) => o.split(eolRegex)),
      git.raw(diffArgs(input.fromHash, input.toHash, "--numstat")).then((o) => o.split(eolRegex))
    ]);
    return { fileChanges: parseDiffFileChanges(nameStatusLines, numStatLines, 0) };
  } catch {
    return { fileChanges: null };
  }
}
