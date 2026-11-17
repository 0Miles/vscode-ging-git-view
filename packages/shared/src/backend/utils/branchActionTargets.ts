/**
 * Pure (vscode-free) derivation of a batch action's targets from the Branches
 * side-view selection. Kept free of any `vscode` import so it can be unit-tested
 * in the fast backend test project. In `@ging/shared` beside `branchTree`, for
 * the same reason: the desktop host resolves a batch's targets in the webview,
 * where its side view is drawn (#399).
 */

import {
  batchSkipReason,
  type HostRefAction,
  isHostAction
} from "@ging/shared/backend/utils/refActionCatalogue";
import type { BatchAction, BatchSkipped, DelegatedBatchAction } from "@ging/shared/types";

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

/** A batch context-menu command's action targets, as refs rather than tree
 *  nodes — the form both the graph webview and the clipboard need. */
export type BranchActionTargets = {
  repo: string;
  /** Branch-list-format refs, in tree order. */
  targets: string[];
  skipped: BatchSkipped[];
};

/** `resolved`, for `repo`, as refs: the form a batch is planned in. */
export function actionTargetRefs(repo: string, resolved: ActionTargets): BranchActionTargets {
  return {
    repo,
    targets: resolved.targets.map((leaf) => leaf.branch),
    skipped: resolved.skipped.map((s) => ({ ref: s.leaf.branch, reason: s.reason }))
  };
}

/** What a batch action comes to, once its targets are resolved. */
export type BatchPlan =
  /** Asks nothing, so it never involves the graph (ADR-0009): run it on the
   *  targets, in tree order. */
  | { kind: "host"; action: HostRefAction; targets: string[] }
  /** A host action with nothing to act on: nothing happens, and nothing is
   *  said — copying no names needs no explanation. */
  | { kind: "none" }
  /** Every selected branch was ruled out: say so, naming them and why —
   *  "nothing happened" reads like a bug. */
  | { kind: "noTargets"; skipped: BatchSkipped[] }
  /** The graph's batch flow, with the skipped ones named in its
   *  confirmation. Never with an empty target set. */
  | {
      kind: "graph";
      action: DelegatedBatchAction;
      repo: string;
      targets: string[];
      skipped: BatchSkipped[];
    };

/** The one decision of a batch run, for both hosts: VS Code's delegate
 *  carries a `graph` plan over to the webview, the desktop side view hands it
 *  to the graph in its own page (ADR-0033). */
export function planBatch(action: BatchAction, resolved: BranchActionTargets): BatchPlan {
  if (isHostAction(action)) {
    return resolved.targets.length === 0
      ? { kind: "none" }
      : { kind: "host", action, targets: resolved.targets };
  }
  if (resolved.targets.length === 0) return { kind: "noTargets", skipped: resolved.skipped };
  return {
    kind: "graph",
    action,
    repo: resolved.repo,
    targets: resolved.targets,
    skipped: resolved.skipped
  };
}

/** The branch a context-menu command operates on. */
export type BranchActionTarget = {
  repo: string;
  branch: string;
  isRemote: boolean;
  isCurrent: boolean;
};
