import type { SimpleGit } from "simple-git";

import type { BranchRedundancy } from "@/backend/types";

import { detectDefaultBranch } from "./defaultBranch";

const eolRegex = /\r\n|\r|\n/g;

/** Run a git command, reporting failure as null rather than throwing: every
 *  step here has its own meaning for "this didn't work". */
async function tryRaw(git: SimpleGit, args: string[]): Promise<string | null> {
  try {
    return await git.raw(args);
  } catch {
    return null;
  }
}

/**
 * Split the branch's own commits by whether the default branch already carries
 * an identical patch. `git cherry` prints one line per commit: `- <sha>` when
 * the patch-id is found upstream, `+ <sha>` when it isn't.
 *
 * The counts are reported to the user as detail, never as the verdict. Patch-ids
 * are wrong in both directions here — they miss a squash (several commits
 * collapsed into one hash differently) and they match a change that was applied
 * and then reverted — which is exactly why the verdict comes from merge-tree.
 */
function countCherry(raw: string | null): { unmerged: number; covered: number } {
  let unmerged = 0;
  let covered = 0;
  if (raw === null) return { unmerged, covered };
  for (const line of raw.split(eolRegex)) {
    if (line.startsWith("+")) unmerged++;
    else if (line.startsWith("-")) covered++;
  }
  return { unmerged, covered };
}

/**
 * Whether `branch` still has anything to contribute to the repo's default
 * branch.
 *
 * The verdict is a single in-memory merge: `git merge-tree --write-tree` merges
 * the two exactly as `git merge` would and prints the resulting tree, so a
 * result equal to the default branch's own tree means merging would be a no-op.
 * That covers squash merges, rebase merges and cherry-picks in one call without
 * a heuristic anywhere — but it answers a state question ("is there anything
 * left?"), not a historical one ("was this branch merged?"). See ADR-0006.
 *
 * `merge-tree --write-tree` needs git 2.38+; on a conflicting merge it exits
 * non-zero while writing only to stdout, which simple-git resolves normally
 * (same as `predictConflicts`), so conflicts arrive here as an ordinary
 * non-matching tree rather than a failure.
 */
export async function checkBranchRedundancy(
  git: SimpleGit,
  input: { branch: string }
): Promise<BranchRedundancy> {
  const defaultBranch = await detectDefaultBranch(git);
  if (defaultBranch === null) return { kind: "unknown", reason: "noDefaultBranch" };

  // Read the target tree before anything can fail for a different reason: a
  // default branch whose own tree won't resolve is no usable default branch,
  // and reporting that as "your git is too old" would be a lie.
  const target = await tryRaw(git, ["rev-parse", defaultBranch + "^{tree}"]);
  if (target === null) return { kind: "unknown", reason: "noDefaultBranch" };

  // Asked before merge-tree so unrelated histories get their own answer rather
  // than merge-tree's "refusing to merge unrelated histories" failure, which is
  // indistinguishable here from git being too old. On unrelated histories
  // `merge-base` exits non-zero with an empty stderr, which simple-git does not
  // treat as an error — hence the emptiness check rather than a null check.
  const base = await tryRaw(git, ["merge-base", defaultBranch, input.branch]);
  if (base === null || base.trim() === "") return { kind: "unknown", reason: "noMergeBase" };

  // The only step that needs git 2.38, so the only one whose failure may be
  // reported as such.
  const merged = await tryRaw(git, ["merge-tree", "--write-tree", defaultBranch, input.branch]);
  if (merged === null) return { kind: "unknown", reason: "unsupported" };

  if (merged.split(eolRegex)[0].trim() === target.trim()) {
    return { kind: "redundant", defaultBranch };
  }

  const cherry = await tryRaw(git, ["cherry", defaultBranch, input.branch]);
  return { kind: "unmerged", defaultBranch, ...countCherry(cherry) };
}
