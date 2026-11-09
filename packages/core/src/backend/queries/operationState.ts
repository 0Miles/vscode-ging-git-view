import * as fs from "node:fs";
import * as path from "node:path";

import type { SimpleGit } from "simple-git";

import type { GitOperation } from "@/backend/types";

/** Detect an in-progress git operation by the marker files/dirs git leaves in
 *  the git dir while it is paused (typically on conflict). Returns null when the
 *  working tree is in a normal state. */
export async function detectOperation(git: SimpleGit): Promise<GitOperation | null> {
  let gitDir: string;
  try {
    gitDir = (await git.raw(["rev-parse", "--absolute-git-dir"])).trim();
  } catch {
    return null;
  }
  const has = (marker: string): boolean => fs.existsSync(path.join(gitDir, marker));
  if (has("MERGE_HEAD")) return "merge";
  // rebase-merge (interactive/merge backend) or rebase-apply (am backend).
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("CHERRY_PICK_HEAD")) return "cherrypick";
  if (has("REVERT_HEAD")) return "revert";
  return null;
}

/** The in-progress operation (if any) and the files with unresolved conflicts. */
export async function operationState(
  git: SimpleGit
): Promise<{ operation: GitOperation | null; conflictedFiles: string[] }> {
  const operation = await detectOperation(git);
  if (operation === null) return { operation: null, conflictedFiles: [] };
  let conflictedFiles: string[] = [];
  try {
    // Unmerged paths (both-modified, added/added, etc.) are diff-filter=U.
    const out = await git.raw([
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "--diff-filter=U"
    ]);
    conflictedFiles = out.split(/\r\n|\r|\n/g).filter((line) => line.length > 0);
  } catch {
    /* leave the list empty — the operation banner still shows continue/abort */
  }
  return { operation, conflictedFiles };
}
