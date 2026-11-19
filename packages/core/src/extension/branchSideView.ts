/**
 * What the Branches side view shows, decided once for both hosts (ADR-0018):
 * which branches are listed, how each is marked, and what it says when a batch
 * action has nothing left to act on. VS Code renders the result as TreeItems
 * (`branchesView.ts`); the desktop host sends it to its webview, which draws it
 * (#399). Kept free of any `vscode` import, like its neighbours.
 */

import type { L10n } from "@ging/core/host/ports";
import { displayRef } from "@ging/shared/backend/utils/branchRef";
import {
  type BranchTreeLeaf,
  type BranchTreeNode,
  buildGroupedBranchRoots
} from "@ging/shared/backend/utils/branchTree";
import type { BatchSkipped, GitRepoState } from "@ging/shared/types";

import { resolveCleanupCandidates } from "./branchCleanup";
import type { BranchFactsResult } from "./branchFacts";
import type { SideViewField } from "./repoSettings";

/** The two hide toggles, as resolved for the repo. */
export type SideViewHideToggles = { showInactive: boolean; showMerged: boolean };

/**
 * The side view's roots for `facts`: the branches neither hide toggle removes,
 * grouped and marked.
 *
 * Both rules yield a fact set and the hidable subset it implies. The facts
 * drive the markings (age label, merged badge) and apply even to exempt
 * branches; only the hidable sets are dimmed and dropped.
 *
 * Hiding is a union across the two toggles: a branch removed by either rule is
 * gone whatever the other says. Dimming covers the whole hidable union, so the
 * grey on a surviving branch always means "some toggle would remove this". The
 * toggles stay here rather than in BranchFacts: they decide presentation, and
 * the graph hides nothing at all.
 *
 * Candidacy is resolved from the same facts, but it is not `hidable`: the
 * exemptions differ by the branch filter, so a leaf can be a candidate without
 * being dimmed (ADR-0017). It changes nothing about how a row looks — only
 * whether it offers the cleanup menu item. The pure resolver, not the cleanup
 * service: the service would spawn git for the basis date on every reload.
 */
export function sideViewBranchRoots(
  facts: BranchFactsResult,
  toggles: SideViewHideToggles,
  exemptPatterns: readonly string[]
): BranchTreeNode[] {
  if (!facts.isRepo) return [];
  const hidden = new Set<string>();
  if (!toggles.showInactive) for (const branch of facts.inactive.hidable) hidden.add(branch);
  if (!toggles.showMerged) for (const branch of facts.merged.hidable) hidden.add(branch);
  const cleanupCandidates = new Set(
    resolveCleanupCandidates({
      branches: facts.branches,
      head: facts.head,
      defaultBranch: facts.defaultBranch,
      dates: facts.dates,
      merged: facts.merged,
      inactive: facts.inactive,
      patterns: exemptPatterns
    }).candidates.map((c) => c.ref)
  );
  return buildGroupedBranchRoots(
    hidden.size === 0 ? facts.branches : facts.branches.filter((b) => !hidden.has(b)),
    facts.head,
    {
      merged: facts.merged.matched,
      inactive: facts.inactive.matched,
      hidable: facts.hidable,
      cleanupCandidates,
      dates: facts.dates
    }
  );
}

/** A side-view toggle's state for a repo: its per-repo override, or the global
 *  default where it has none. `state` is undefined for a repo not held. */
export function resolveSideViewToggle(
  state: GitRepoState | undefined,
  field: SideViewField,
  globalDefault: boolean
): boolean {
  return state?.[field] ?? globalDefault;
}

/** One branch Search Branch offers: the tree's leaf, whether it is the one
 *  checked out (marked current), and whether the filter holds it (checked
 *  when the picker opens). */
export type SideViewSearchItem = { leaf: BranchTreeLeaf; current: boolean; picked: boolean };

/** A run of Search Branch's rows: the remote branches or the local ones.
 *  `named` when both runs are there, so each goes under its group's name. */
export type SideViewSearchGroup = {
  group: "remote" | "local";
  named: boolean;
  items: SideViewSearchItem[];
};

/**
 * What Search Branch offers over the tree `roots` (#459): every leaf the tree
 * lists — so what the toggles and the hidden remotes leave in it — in the
 * tree's order, remote ones first, then local; an empty run is left out, and
 * the runs are named only when there are two. Each host draws the rows its
 * own way: VS Code's QuickPick (`searchBranch` in branchesView.ts), the
 * desktop's host prompt overlay (sideViews.ts). Nothing at all when the tree
 * lists no branch.
 */
export function sideViewSearchGroups(
  roots: readonly BranchTreeNode[],
  filter: readonly string[]
): SideViewSearchGroup[] {
  const leaves: BranchTreeLeaf[] = [];
  const walk = (nodes: readonly BranchTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "leaf") leaves.push(node);
      else walk(node.children);
    }
  };
  walk(roots);
  const held = new Set(filter);
  const runs = (["remote", "local"] as const)
    .map((group) => ({
      group,
      items: leaves
        .filter((leaf) => leaf.isRemote === (group === "remote"))
        .map((leaf) => ({ leaf, current: leaf.isHead, picked: held.has(leaf.branch) }))
    }))
    .filter((run) => run.items.length > 0);
  const named = runs.length > 1;
  return runs.map(({ group, items }) => ({ group, named, items }));
}

/**
 * What to say when every selected branch was ruled out of a batch action: that
 * nothing can take it, then the same "skipped, because X" lines the batch
 * confirmation dialog shows — naming them and the reason is the whole point;
 * "nothing happened" reads like a bug.
 */
export function batchNoTargetsMessage(l10n: L10n, skipped: readonly BatchSkipped[]): string {
  const notes = (
    [
      ["checkedOut", "dialog.batch.skippedCheckedOut"],
      ["remote", "dialog.batch.skippedRemote"]
    ] as const
  ).flatMap(([reason, key]) => {
    const refs = skipped.filter((s) => s.reason === reason).map((s) => displayRef(s.ref));
    return refs.length === 0 ? [] : [l10n.t(key, refs.join(", "))];
  });
  return [l10n.t("branchView.batch.noTargets"), ...notes].join(" ");
}
