import type { SimpleGit } from "simple-git";

const eolRegex = /\r\n|\r|\n/g;

type PredictConflictsInput = {
  ours: string;
  theirs: string;
};

/** Predict which files would conflict if `theirs` were merged into `ours`,
 *  without touching the working tree.
 *
 *  `git merge-tree --write-tree` (git 2.38+) performs a full recursive merge in
 *  memory, computing the merge base(s) itself — exactly as `git merge` would.
 *  On conflict it exits non-zero but writes only to stdout (nothing to stderr),
 *  and simple-git flags an error only when the exit code is non-zero AND stderr
 *  is non-empty, so the promise resolves with the output in both the clean and
 *  conflicting cases. The output is: line 0 = merged-tree OID, then (from
 *  `--name-only`) the conflicted file paths up to a blank line, then
 *  informational messages we ignore. `core.quotePath=false` keeps non-ASCII
 *  paths raw, matching the other queries.
 *
 *  On any failure (git too old for `--write-tree`, an invalid ref, or a real
 *  error that does write to stderr) we report `ok: false` so callers can degrade
 *  gracefully rather than show a misleading result. */
export async function predictConflicts(
  git: SimpleGit,
  input: PredictConflictsInput
): Promise<{ ok: boolean; conflictFiles: string[] }> {
  try {
    const out = await git.raw([
      "-c",
      "core.quotePath=false",
      "merge-tree",
      "--write-tree",
      "--name-only",
      input.ours,
      input.theirs
    ]);
    const lines = out.split(eolRegex);
    const conflictFiles: string[] = [];
    // Skip line 0 (the merged-tree OID); collect file paths until the blank
    // line separating them from the informational messages.
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "") break;
      conflictFiles.push(lines[i]);
    }
    return { ok: true, conflictFiles };
  } catch {
    return { ok: false, conflictFiles: [] };
  }
}
