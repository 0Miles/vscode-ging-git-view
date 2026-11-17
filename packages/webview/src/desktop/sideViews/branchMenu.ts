/* The desktop Branches view's context menus (#399), as data: which branch
 * actions a row offers, read off the shared action catalogue (ADR-0010) — its
 * kinds, its head guard, whether it needs a remote, whether it can batch, and
 * the setting that hides it. VS Code's side view states the same facts as
 * package.json when-clauses; here they are derived, since the menu is drawn by
 * the page. Labels are the graph's own (`l10n`) for single actions — the same
 * actions, by the same names — and the host's for the batch ones, which the
 * graph has no menu for. */

import {
  type BranchCmvCategory,
  CATALOGUE_REF_ACTIONS,
  type CatalogueRefAction,
  type CmvKey,
  isBatchAction,
  REF_ACTION_CATALOGUE,
  refActionVisibility
} from "@ging/shared/backend/utils/refActionCatalogue";
import type { BatchAction, ContextMenuActionsVisibility } from "@ging/shared/types";
import { ELLIPSIS } from "@ging/webview/utils/git";
import type { SvgIconName } from "@ging/webview/utils/icons";

/** What a row's menu is decided from, besides the row. */
export type BranchMenuContext = {
  cmv: Pick<ContextMenuActionsVisibility, BranchCmvCategory>;
  /** The repo has at least one remote (`needsRemotes`). */
  hasRemotes: boolean;
};

/** The two facts of a row the catalogue's rules read. */
export type BranchRowFacts = { isRemote: boolean; isHead: boolean };

/** Where an action sits in a row's menu (items of one group between two
 *  dividers, in VS Code's side-view groups' order), its label and its icon. */
type ActionPresentation = {
  group: number;
  label: (row: BranchRowFacts) => string;
  icon?: SvgIconName;
  /** False for the one action whose single-selection spelling on a remote
   *  branch is another action: `delete` is offered there as `deleteRemote`
   *  (the catalogue's note on `delete`), though the batch delete takes both. */
  singleOnRemote?: false;
};

/** One entry per catalogue action: a new action fails to compile here until it
 *  has a place in the menu, so none can be left out unseen (ADR-0010). In the
 *  menu's order. */
const PRESENTATION: Record<CatalogueRefAction, ActionPresentation> = {
  checkout: {
    group: 1,
    // A remote branch's checkout asks for the local branch's name first.
    label: (row) => (row.isRemote ? l10n.checkoutBranch + ELLIPSIS : l10n.checkoutBranch),
    icon: "arrowSwitch"
  },
  rename: { group: 1, label: () => l10n.renameBranch + ELLIPSIS, icon: "pencil" },
  push: { group: 1, label: () => l10n.pushBranch + ELLIPSIS, icon: "repoPush" },
  createArchive: { group: 1, label: () => l10n.createArchive + ELLIPSIS },
  delete: {
    group: 2,
    label: () => l10n.deleteBranch + ELLIPSIS,
    icon: "trash",
    singleOnRemote: false
  },
  merge: { group: 2, label: () => l10n.merge + ELLIPSIS, icon: "gitMerge" },
  // Always the plain rebase: the side view cannot see the graph's comparison.
  rebase: { group: 2, label: () => l10n.rebaseOnBranch + ELLIPSIS, icon: "rebase" },
  fastForward: { group: 2, label: () => l10n.fastForwardBranch, icon: "moveToEnd" },
  pull: { group: 2, label: () => l10n.pullIntoCurrentBranch + ELLIPSIS, icon: "repoPull" },
  fetchIntoLocal: {
    group: 2,
    label: () => l10n.fetchIntoLocalBranch + ELLIPSIS,
    icon: "download"
  },
  deleteRemote: { group: 2, label: () => l10n.deleteRemoteBranch + ELLIPSIS, icon: "trash" },
  checkRedundancy: { group: 3, label: () => l10n.checkRedundancy },
  createPullRequest: {
    group: 4,
    label: () => l10n.createPullRequest + ELLIPSIS,
    icon: "gitPullRequest"
  },
  copyName: { group: 5, label: () => l10n.copyBranchName, icon: "copy" }
};

/** The group the cleanup item joins: the one that changes branches. */
const CLEANUP_GROUP = 2;

const categoryOf = (row: BranchRowFacts): BranchCmvCategory =>
  row.isRemote ? "remoteBranch" : "branch";

/**
 * Whether `action` applies to `row` on its own — every catalogue rule that a
 * single row can answer. The head guard is one of them: an action that never
 * applies to the checked-out branch is simply not offered there, and running
 * one anyway (`runsOn`) does nothing, without a word — the menu never offered
 * it (ADR-0010, ADR-0033).
 */
export function singleActionApplies(
  action: CatalogueRefAction,
  row: BranchRowFacts,
  ctx: BranchMenuContext
): boolean {
  const spec = REF_ACTION_CATALOGUE[action];
  if (spec.refKinds === (row.isRemote ? "local" : "remote")) return false;
  if (spec.headGuard && row.isHead) return false;
  if (spec.needsRemotes && !ctx.hasRemotes) return false;
  if (row.isRemote && PRESENTATION[action].singleOnRemote === false) return false;
  return refActionVisibility(action, categoryOf(row), ctx.cmv) !== false;
}

/**
 * Whether a batch `action` is offered on a multi-selection: it needs no remote
 * the repo lacks, and a setting on either side of its key still shows it — the
 * selection may hold both kinds, and each side's half of the action is hidden
 * by its own setting (VS Code's `deleteSelected` is shown while either of
 * `branch.delete` / `remoteBranch.delete` is).
 */
export function batchActionApplies(action: BatchAction, ctx: BranchMenuContext): boolean {
  const spec = REF_ACTION_CATALOGUE[action];
  if (spec.needsRemotes && !ctx.hasRemotes) return false;
  const cmvKey: CmvKey | null = spec.cmvKey;
  if (cmvKey === null) return true;
  return (
    (cmvKey.branch !== undefined && ctx.cmv.branch[cmvKey.branch]) ||
    (cmvKey.remoteBranch !== undefined && ctx.cmv.remoteBranch[cmvKey.remoteBranch])
  );
}

/** Items in groups, a divider between two groups. */
function grouped(items: { group: number; item: ContextMenuItem }[]): ContextMenuElement[] {
  const menu: ContextMenuElement[] = [];
  let group: number | null = null;
  for (const entry of items.toSorted((a, b) => a.group - b.group)) {
    if (group !== null && entry.group !== group) menu.push(null);
    group = entry.group;
    menu.push(entry.item);
  }
  return menu;
}

/** One row's menu: the actions that apply to it, and the cleanup dialog when
 *  the row is itself a candidate (ADR-0017: the row is the affordance, not the
 *  target). */
export function singleBranchMenu(
  row: BranchRowFacts & { isCleanupCandidate: boolean },
  ctx: BranchMenuContext,
  handlers: {
    run: (action: CatalogueRefAction) => void;
    cleanup: () => void;
  }
): ContextMenuElement[] {
  const items = CATALOGUE_REF_ACTIONS.filter((action) => singleActionApplies(action, row, ctx)).map(
    (action) => {
      const { group, label, icon } = PRESENTATION[action];
      return { group, item: { title: label(row), icon, onClick: () => handlers.run(action) } };
    }
  );
  if (row.isCleanupCandidate) {
    items.push({
      group: CLEANUP_GROUP,
      item: { title: l10n.cleanupMenuItem, icon: "trash", onClick: handlers.cleanup }
    });
  }
  return grouped(items);
}

/** A multi-selection's menu: the batch actions alone (ADR-0009 — the others
 *  are hidden, never aimed at one row of the selection). `labels` are already
 *  escaped. */
export function batchBranchMenu(
  ctx: BranchMenuContext,
  labels: Record<BatchAction, string>,
  run: (action: BatchAction) => void
): ContextMenuElement[] {
  const actions = CATALOGUE_REF_ACTIONS.filter(isBatchAction);
  return grouped(
    actions
      .filter((action) => batchActionApplies(action, ctx))
      .map((action) => ({
        group: PRESENTATION[action].group,
        item: { title: labels[action], icon: PRESENTATION[action].icon, onClick: () => run(action) }
      }))
  );
}
