/**
 * Pure (vscode-free) derivation of a repo's **cleanup candidates** — the
 * branches the cleanup dialog proposes deleting (CONTEXT.md, "Cleanup
 * candidate").
 *
 * A candidate is a *proposal*, never a claim about the branch. The three facts
 * behind it have wildly different strengths: merged carries git's own
 * `branch -d` guarantee, redundant does not, and inactive says nothing at all
 * about whether deleting would lose work. That is why each row carries which
 * facts put it there, and why nothing here decides what is pre-checked — see
 * `webview/branchCleanup.ts` and ADR-0015.
 *
 * Candidacy is close to `hidable` but is not it: the exemptions differ by
 * exactly one entry, the branch filter (see `isCleanupExempt`). Read the *fact*
 * sets of the classifications, never their hidable subsets.
 *
 * Kept free of any `vscode` import so it runs in the fast backend test project,
 * like the classifiers it consumes.
 */

import { REMOTE_PREFIX } from "@/backend/utils/branchRef";
import type { CleanupCandidate, CleanupCandidateFacts } from "@/types";

import { type BranchClassification, defaultBranchAliases, isAlwaysShown } from "./branchExempt";
import { type BranchTreeNode, buildGroupedBranchRoots } from "./branchTree";

export type CleanupCandidatesInput = {
  branches: readonly string[];
  head: string | null;
  defaultBranch: string | null;
  dates: Readonly<Record<string, number>>;
  /** The merged classification, as `branchFacts` produces it. */
  merged: BranchClassification;
  /** The inactive classification, as `branchFacts` produces it. */
  inactive: BranchClassification;
  /** Refs a deep check has judged redundant. Empty until the user asks for one. */
  redundant?: ReadonlySet<string>;
  /** "Always show" name/glob patterns. */
  patterns: readonly string[];
};

export type CleanupCandidates = {
  candidates: CleanupCandidate[];
  /** The basis the merged and redundant facts were measured against, for the
   *  dialog's basis line. Null disables both — and so the deep check too. */
  defaultBranch: string | null;
  /** What a deep check would ask git about: every non-exempt branch not already
   *  known merged. Deliberately wider than `candidates` — the branch squash
   *  merged yesterday is in neither fact set, so only scanning beyond the list
   *  can surface it. Empty when there is no default branch to compare against. */
  scannable: string[];
};

/**
 * Whether a branch is exempt from ever being proposed.
 *
 * Three reasons, and deliberately **not** the branch filter — that is the one
 * exemption `hidable` has and this does not. The filter often holds exactly the
 * branches about to be deleted (ADR-0008 notes the graph then previews them), so
 * honouring it here would hide the candidates from the dialog that exists to
 * list them.
 */
function isCleanupExempt(ref: string, input: CleanupCandidatesInput): boolean {
  if (ref === input.head) return true; // git can't delete the branch you're on
  if (input.defaultBranch !== null && defaultBranchAliases(input.defaultBranch).has(ref)) {
    return true; // the basis every verdict was measured against
  }
  return isAlwaysShown(ref, input.patterns);
}

/** The refs in the order the side-view tree would show them — the remote group
 *  first, mainline names before the rest, folders after the leaves beside them.
 *  Built from the same tree module as the view rather than re-sorting here, so
 *  the dialog can never order the same branches differently. */
function inTreeOrder(refs: readonly string[], head: string | null): string[] {
  const ordered: string[] = [];
  const walk = (nodes: readonly BranchTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "leaf") ordered.push(node.branch);
      else walk(node.children);
    }
  };
  walk(buildGroupedBranchRoots(refs, head));
  return ordered;
}

export function resolveCleanupCandidates(input: CleanupCandidatesInput): CleanupCandidates {
  const redundant = input.redundant ?? new Set<string>();
  const facts = new Map<string, CleanupCandidateFacts>();
  const scannable: string[] = [];
  for (const ref of input.branches) {
    if (isCleanupExempt(ref, input)) continue;
    const row: CleanupCandidateFacts = {
      // The *fact* sets, never the hidable ones: see `isCleanupExempt`.
      merged: input.merged.matched.has(ref),
      redundant: redundant.has(ref),
      inactive: input.inactive.matched.has(ref)
    };
    // A merged branch is redundant by definition, so asking git about it would
    // spend a full in-memory merge on an answer already in hand.
    if (!row.merged && input.defaultBranch !== null) scannable.push(ref);
    if (!row.merged && !row.redundant && !row.inactive) continue;
    facts.set(ref, row);
  }
  const candidates = inTreeOrder([...facts.keys()], input.head).map((ref) => ({
    ref,
    isRemote: ref.startsWith(REMOTE_PREFIX),
    facts: facts.get(ref)!,
    lastActivitySec: input.dates[ref]
  }));
  return {
    candidates,
    defaultBranch: input.defaultBranch,
    // Same order as the rows, so the scan's progress advances the way the list
    // reads rather than in whatever order git listed the branches.
    scannable: inTreeOrder(scannable, input.head)
  };
}
