/**
 * Pure (vscode-free) derivation of a batch action's targets from the Branches
 * side-view selection. Kept free of any `vscode` import so it can be unit-tested
 * in the fast backend test project, like its neighbours in this directory.
 */

import { batchSkipReason } from "@/backend/utils/refActionCatalogue";
import type { BatchAction } from "@/types";

import type { BranchTreeLeaf, BranchTreeNode } from "./branchTree";

/** Why a selected branch is not a target. Only reasons the side-view can know
 *  on its own: whatever needs git to answer (not fully merged, no upstream) is
 *  left to fail at execution and be reported in the result summary. */
export type SkipReason = "checkedOut" | "remote";

export type SkippedTarget = { leaf: BranchTreeLeaf; reason: SkipReason };

export type ActionTargets = {
  /** The branches the action will actually run against, in tree order. */
  targets: BranchTreeLeaf[];
  /** Selected branches the action cannot apply to, in tree order. Always shown
   *  to the user — the gap between what they selected and what will happen is
   *  never silent. */
  skipped: SkippedTarget[];
};

/** The action targets for `selected` (a set of refs, in any order). Which
 *  branches an action rules out is derived from the shared action catalogue
 *  (`batchSkipReason`), the same facts the single-action path enforces. */
export function resolveActionTargets(
  roots: readonly BranchTreeNode[],
  selected: readonly string[],
  action: BatchAction
): ActionTargets {
  const wanted = new Set(selected);
  const targets: BranchTreeLeaf[] = [];
  const skipped: SkippedTarget[] = [];
  // Walking the tree rather than the selection array is what puts the result in
  // tree order — the order the user sees — and what drops folder and group
  // nodes, which are display grouping with no git meaning.
  const walk = (nodes: readonly BranchTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "leaf") {
        if (!wanted.has(node.branch)) continue;
        const reason = batchSkipReason(action, node);
        if (reason === null) targets.push(node);
        else skipped.push({ leaf: node, reason });
      } else {
        walk(node.children);
      }
    }
  };
  walk(roots);
  return { targets, skipped };
}
