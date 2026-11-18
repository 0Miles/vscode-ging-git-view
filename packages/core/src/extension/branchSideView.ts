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
