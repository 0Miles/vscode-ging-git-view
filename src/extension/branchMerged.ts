/**
 * Pure (vscode-free) classification of "merged" branches — those whose tip is
 * already an ancestor of the default branch, i.e. the ones `git branch -d` will
 * delete without complaint. The ancestry itself is resolved by git (see
 * `loadBranches`); this module only decides which of those refs are worth
 * telling the user about, and which of them may be hidden.
 *
 * The judgement is deliberately ancestry-only: squash and rebase merges are not
 * detected. See ADR-0002 — the badge's promise is that a marked branch really
 * is safe to delete, so no heuristic that could produce a false positive is
 * allowed anywhere near it.
 */

import { splitRemoteRef } from "@/backend/utils/branchRef";

import {
  type BranchClassification,
  type BranchExemptions,
  emptyClassification,
  withExemptions
} from "./branchExempt";

export type ClassifyMergedInput = {
  branches: readonly string[];
  /** Refs reported merged by git, in branch-list format. */
  merged: readonly string[];
  /** The default branch every ref was tested against; null when it couldn't be
   *  resolved, which disables the whole feature. */
  defaultBranch: string | null;
  exemptions: BranchExemptions;
};

/** The refs that denote the default branch itself and must never be reported as
 *  merged: the resolved ref, plus — when it is remote-tracking — the local
 *  branch of the same name. Reporting the default branch as already merged into
 *  the default branch is a tautology, not information. */
function defaultBranchAliases(defaultBranch: string): Set<string> {
  const aliases = new Set([defaultBranch]);
  const split = splitRemoteRef(defaultBranch);
  if (split !== null) aliases.add(split.name);
  return aliases;
}

/**
 * The branches already merged into the default branch, paired with the subset
 * that may be hidden. Returns nothing classified when no default branch could
 * be resolved — with nothing to be merged into, a guess would break the badge's
 * "safe to delete" promise.
 */
export function classifyMerged(input: ClassifyMergedInput): BranchClassification {
  const { branches, merged, defaultBranch, exemptions } = input;
  if (defaultBranch === null) return emptyClassification();
  const aliases = defaultBranchAliases(defaultBranch);
  const reported = new Set(merged);
  const matched = new Set<string>();
  // Intersect with `branches` rather than trusting the git output verbatim: the
  // two are read separately, and only refs the view actually lists can be
  // marked.
  for (const branch of branches) {
    if (aliases.has(branch)) continue;
    if (reported.has(branch)) matched.add(branch);
  }
  return withExemptions(matched, exemptions);
}
