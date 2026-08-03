import type { SimpleGit } from "simple-git";

import type { BranchRedundancy, DateType, RedundancyCommit } from "@/backend/types";

import { detectDefaultBranch } from "./defaultBranch";

const eolRegex = /\r\n|\r|\n/g;
const fieldSeparator = "XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb";

/** How many of the branch's commits the dialog will list. A long-lived branch
 *  can have thousands, and every one of them costs a row of HTML built into a
 *  single `innerHTML` string — enough to lock up the webview. */
const MAX_LISTED_COMMITS = 200;

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
 * Parse the branch's own commits out of a `--cherry-mark` log. `%m` is `=` when
 * the other side already carries an identical patch, and the plain right-side
 * `>` when it doesn't.
 *
 * These marks are reported to the user as detail, never as the verdict.
 * Patch-ids are wrong in both directions here — they miss a squash (several
 * commits collapsed into one hash differently) and they match a change that was
 * applied and then reverted — which is exactly why the verdict comes from
 * merge-tree.
 */
function parseCherryMarkLog(raw: string | null): RedundancyCommit[] {
  if (raw === null) return [];
  const commits: RedundancyCommit[] = [];
  for (const line of raw.split(eolRegex)) {
    const fields = line.split(fieldSeparator);
    if (fields.length < 6) continue;
    const date = Number(fields[4]);
    commits.push({
      hash: fields[1],
      author: fields[2],
      email: fields[3],
      date: Number.isFinite(date) ? date : 0,
      // The subject is last, so a separator inside it can't shift the fields.
      subject: fields.slice(5).join(fieldSeparator),
      covered: fields[0] === "="
    });
  }
  return commits;
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
  input: { branch: string; useMailmap: boolean; dateType: DateType }
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

  // `--right-only` keeps the branch's own commits; `--cherry-mark` sets `%m` to
  // `=` on the ones whose patch the default branch already carries.
  //
  // `--no-merges` matches what `git cherry` does implicitly (it passes
  // `--max-parents=1`). Without it a branch that merged the default branch back
  // in lists that merge commit as its own work, and expanding it would diff
  // against its first parent — i.e. show every file the default branch changed
  // since the fork.
  const log = await tryRaw(git, [
    "log",
    "--right-only",
    "--cherry-mark",
    "--no-merges",
    "--max-count=" + (MAX_LISTED_COMMITS + 1),
    "--format=" +
      [
        "%m",
        "%H",
        input.useMailmap ? "%aN" : "%an",
        input.useMailmap ? "%aE" : "%ae",
        // Same basis as the graph's rows, so the two never date a commit
        // differently (`loadCommits` picks the field the same way).
        input.dateType === "Author Date" ? "%at" : "%ct",
        "%s"
      ].join(fieldSeparator),
    defaultBranch + "..." + input.branch
  ]);
  const commits = parseCherryMarkLog(log);
  return {
    kind: "unmerged",
    defaultBranch,
    // One over the cap was requested so the extra proves there are more; the
    // dialog says so rather than silently rendering a truncated list.
    truncated: commits.length > MAX_LISTED_COMMITS,
    commits: commits.slice(0, MAX_LISTED_COMMITS)
  };
}
