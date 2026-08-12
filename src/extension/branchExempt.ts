/**
 * Pure (vscode-free) vocabulary shared by the two branch-classification rules,
 * inactive (`branchActivity.ts`) and merged (`branchMerged.ts`).
 *
 * Both rules produce the same shape: a *fact* set — every branch the rule
 * matches, exemptions ignored — and a *hidable* set, the fact minus the
 * branches the user has signalled they always want to see. Keeping the two
 * apart is deliberate (see ADR-0003): the fact drives marking (the age label,
 * the merged badge) and applies even to exempt branches, while only the hidable
 * set is dimmed and removed by the hide toggles.
 *
 * Kept free of any `vscode` import so it runs in the fast backend test project.
 */

import { displayRef, splitRemoteRef } from "@/backend/utils/branchRef";

export type BranchClassification = {
  /** Every branch matching the rule. Exemptions ignored — this is the fact. */
  matched: ReadonlySet<string>;
  /** `matched` minus the exempt branches: dimmed in the view, and removed
   *  altogether while the corresponding hide toggle is off. */
  hidable: ReadonlySet<string>;
};

/** The branches never hidden, whatever the rules say. */
export type BranchExemptions = {
  /** The checked-out branch — hiding it would make the view lie about where
   *  you are. Null when detached. */
  head: string | null;
  /** Refs in the active filter selection. Hiding one would prune it out of the
   *  graph's filter, silently turning the filter back into "show all". */
  selected: readonly string[];
  /** "Always show" name/glob patterns from configuration. */
  patterns: readonly string[];
};

/** Names to test against the "always show" patterns: the ref itself and, for a
 *  remote-tracking branch, the value with the `remotes/` prefix stripped
 *  (`origin/main`) and with the remote stripped too (`main`). So a pattern like
 *  `main` exempts `main`, `origin/main` and `remotes/origin/main` alike. */
function exemptCandidates(branch: string): string[] {
  const split = splitRemoteRef(branch);
  return split === null ? [branch] : [branch, displayRef(branch), split.name];
}

/** Match `name` against a glob `pattern` supporting `*` (any run, incl. empty)
 *  and `?` (one char). Anchored full-string, case-sensitive (branch names are).
 *  All other regex metacharacters are matched literally. */
export function branchGlobMatches(name: string, pattern: string): boolean {
  // Escape regex metachars except the glob wildcards `*` and `?`...
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // ...then translate the wildcards. A run of `*` collapses to one `.*` so a
  // pathological pattern (`***…`) can't trigger catastrophic backtracking.
  const body = escaped.replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + body + "$").test(name);
}

/** Whether any "always show" pattern matches the branch (across its display
 *  variants — see {@link exemptCandidates}). */
export function isAlwaysShown(branch: string, patterns: readonly string[]): boolean {
  const candidates = exemptCandidates(branch);
  return patterns.some((p) => candidates.some((c) => branchGlobMatches(c, p)));
}

/**
 * The refs that denote the default branch itself: the resolved ref, plus — when
 * it is remote-tracking — the local branch of the same name.
 *
 * Shared by the two rules that measure against the default branch: merged
 * classification must not report it as merged into itself, and the cleanup
 * dialog must not propose deleting the basis every verdict was measured
 * against. One holder so the two can't disagree about what counts as it.
 */
export function defaultBranchAliases(defaultBranch: string): Set<string> {
  const aliases = new Set([defaultBranch]);
  const split = splitRemoteRef(defaultBranch);
  if (split !== null) aliases.add(split.name);
  return aliases;
}

/** Whether the branch is exempt from hiding for any of the three reasons. */
export function isExempt(branch: string, exemptions: BranchExemptions): boolean {
  if (branch === exemptions.head) return true;
  if (exemptions.selected.includes(branch)) return true;
  return isAlwaysShown(branch, exemptions.patterns);
}

/** Pair a fact set with the hidable subset it implies. */
export function withExemptions(
  matched: ReadonlySet<string>,
  exemptions: BranchExemptions
): BranchClassification {
  const hidable = new Set<string>();
  for (const branch of matched) {
    if (!isExempt(branch, exemptions)) hidable.add(branch);
  }
  return { matched, hidable };
}

/** Nothing classified, for the disabled paths (no threshold configured, no
 *  default branch resolvable). */
export function emptyClassification(): BranchClassification {
  return { matched: new Set(), hidable: new Set() };
}
