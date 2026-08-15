/**
 * The single declaration of every branch action the Branches side-view offers
 * (ADR-0010). Both halves of the delegation pipeline read it: the extension
 * host validates and routes against it before sending, the graph webview keys
 * its handler table by it. The command registrations, the wire-type unions and
 * the batch skip rules are all derived from here — adding an action means
 * adding one entry (plus its package.json menu item and webview handler).
 *
 * Availability is declared here too: `cmvKey` names the visibility setting(s)
 * that hide an action. The graph webview's ref menu reads its `visible:`
 * gates straight off it (`refActionVisibility`), and package.json's
 * hand-written `branches.*` when-clauses must agree with the declarations —
 * tests/backend/utils/branchMenuConsistency.test.ts reads the real
 * package.json and goes red on any divergence.
 */

import type { ContextMenuActionsVisibility } from "@/types";

export type RefKinds = "local" | "remote" | "both";

type BranchCmvSetting = keyof ContextMenuActionsVisibility["branch"];
type RemoteBranchCmvSetting = keyof ContextMenuActionsVisibility["remoteBranch"];

/** The `contextMenuActionsVisibility` setting(s) that hide a branch action,
 *  one per category the action appears in: `branch` gates it on local
 *  branches, `remoteBranch` on remote-tracking ones. At least one side is
 *  always present — an action with a key on neither side declares
 *  `cmvKey: null` instead. Which side applies to a given ref follows from
 *  `refKinds` (CONTEXT.md, "Ref 的兩種形"): the `remotes/` prefix decides the
 *  category, so a `refKinds: "both"` action typically declares both sides. */
export type CmvKey =
  | { branch: BranchCmvSetting; remoteBranch?: RemoteBranchCmvSetting }
  | { branch?: BranchCmvSetting; remoteBranch: RemoteBranchCmvSetting };

export type RefActionSpec = {
  /** Which branches the action applies to. On the wire, the `remotes/` prefix
   *  of the canonical ref is the fact this is checked against — no separate
   *  remote flag travels with it (CONTEXT.md, "Ref 的兩種形"). */
  refKinds: RefKinds;
  /** True when the action never applies to the checked-out branch — the same
   *  fact package.json expresses as `viewItem == branch-local` (rather than
   *  `branch-(local|current)`). The host returns early on it; batch resolution
   *  reports it as `skipped: checkedOut`. */
  headGuard: boolean;
  /** Whether the action splits into N independent steps and so may run against
   *  a multi-selection (CONTEXT.md, "Batch action"). */
  batch: boolean;
  /** True when the action is meaningless without a remote; the webview (the
   *  only side that knows the remotes) drops it when there are none. */
  needsRemotes: boolean;
  /** Where the action executes: "graph" delegates to the webview so the exact
   *  in-graph menu flow (dialogs included) runs; "host" runs in the extension
   *  host without disturbing the panel (ADR-0009 — it asks nothing). */
  runsIn: "graph" | "host";
  /** Which `contextMenuActionsVisibility` setting(s) hide the action, per
   *  branch category. `null` declares the action has no visibility setting
   *  and is always shown — a recorded fact, not an omission (fastForward,
   *  createPullRequest). Both menus follow this field: the side-view through
   *  `branchMenuContextKeys` (its package.json when-clauses stay hand-written,
   *  locked by the consistency test), the graph webview through
   *  `refActionVisibility`. */
  cmvKey: CmvKey | null;
};

export const REF_ACTION_CATALOGUE = {
  checkout: {
    refKinds: "both",
    headGuard: true,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { branch: "checkout", remoteBranch: "checkout" }
  },
  rename: {
    refKinds: "local",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { branch: "rename" }
  },
  // `refKinds: "both"`: the single-selection menu only offers `delete` on local
  // branches (`deleteRemote` is the remote wording), but a batch delete accepts
  // remote-tracking refs — deleting one just takes the other git command — so
  // "delete" as an action applies to both kinds and the webview routes by the
  // ref's prefix. The `remoteBranch` side of the key is `deleteRemote`'s
  // setting: it gates the batch delete's remote half, so `deleteSelected`
  // shows while either half is still visible.
  delete: {
    refKinds: "both",
    headGuard: true,
    batch: true,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { branch: "delete", remoteBranch: "delete" }
  },
  merge: {
    refKinds: "both",
    headGuard: true,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { branch: "merge", remoteBranch: "merge" }
  },
  rebase: {
    refKinds: "local",
    headGuard: true,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { branch: "rebase" }
  },
  // `cmvKey: null` — fast-forward has never had a visibility setting and stays
  // always shown; the consistency test locks this declared fact. Growing a key
  // later means filling this field in, not archaeology.
  fastForward: {
    refKinds: "local",
    headGuard: true,
    batch: true,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: null
  },
  push: {
    refKinds: "local",
    headGuard: false,
    batch: true,
    needsRemotes: true,
    runsIn: "graph",
    cmvKey: { branch: "push" }
  },
  createArchive: {
    refKinds: "local",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { branch: "createArchive" }
  },
  // `cmvKey: null` — same declared fact as fastForward: no visibility setting
  // exists, the action cannot be hidden.
  createPullRequest: {
    refKinds: "both",
    headGuard: false,
    batch: false,
    needsRemotes: true,
    runsIn: "graph",
    cmvKey: null
  },
  pull: {
    refKinds: "remote",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { remoteBranch: "pull" }
  },
  // The settings spelling is "fetch", not "fetchIntoLocal" — the cmv schema
  // predates the catalogue's action names.
  fetchIntoLocal: {
    refKinds: "remote",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { remoteBranch: "fetch" }
  },
  // Shares `remoteBranch.delete` with `delete`: one setting hides remote
  // deletion everywhere, whether spelled `deleteRemote` (single selection) or
  // reached through the batch delete.
  deleteRemote: {
    refKinds: "remote",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { remoteBranch: "delete" }
  },
  checkRedundancy: {
    refKinds: "both",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph",
    cmvKey: { branch: "checkRedundancy", remoteBranch: "checkRedundancy" }
  },
  copyName: {
    refKinds: "both",
    headGuard: false,
    batch: true,
    needsRemotes: false,
    runsIn: "host",
    cmvKey: { branch: "copyName", remoteBranch: "copyName" }
  }
} as const satisfies Record<string, RefActionSpec>;

/** Every side-view branch action, `runsIn` regardless. */
export type CatalogueRefAction = keyof typeof REF_ACTION_CATALOGUE;

type ActionsWhere<F extends keyof RefActionSpec, V> = {
  [K in CatalogueRefAction]: (typeof REF_ACTION_CATALOGUE)[K][F] extends V ? K : never;
}[CatalogueRefAction];

/** A branch action the side-view delegates to the graph webview, so the exact
 *  same context-menu flow (dialogs included) runs there. */
export type RefAction = ActionsWhere<"runsIn", "graph">;

/** An action that runs against the whole selection when several branches are
 *  selected. Membership is decided by git semantics, not UI convenience — only
 *  operations that split into N independent steps qualify (CONTEXT.md, "Batch
 *  action"), which is why `merge` and `pull` are absent. */
export type BatchAction = ActionsWhere<"batch", true>;

/** The batch actions that ask the user something, and so run their dialog in
 *  the graph webview (ADR-0009). `copyName` is the sole exclusion: it asks
 *  nothing and runs in the extension host without opening the graph. */
export type DelegatedBatchAction = Exclude<BatchAction, ActionsWhere<"runsIn", "host">>;

/** The catalogue actions that run in the extension host (ADR-0009). */
export type HostRefAction = ActionsWhere<"runsIn", "host">;

export const CATALOGUE_REF_ACTIONS = Object.keys(REF_ACTION_CATALOGUE) as CatalogueRefAction[];

export const isHostAction = (action: CatalogueRefAction): action is HostRefAction =>
  REF_ACTION_CATALOGUE[action].runsIn === "host";

export const isBatchAction = (action: CatalogueRefAction): action is BatchAction =>
  REF_ACTION_CATALOGUE[action].batch;

/**
 * The side-view's `ging-git-view.cmv.*` when-clause context keys, projected
 * from the catalogue's `cmvKey` declarations: one key per declared settings
 * key, valued by the given visibility snapshot. `delete` and `deleteRemote`
 * both declare `remoteBranch.delete` — one settings key, so one context key,
 * set once. extension.ts pipes each entry to `setContext` verbatim; declaring
 * a new `cmvKey` here is all it takes for the side-view menu to follow it.
 */
export function branchMenuContextKeys(
  cmv: Pick<ContextMenuActionsVisibility, "branch" | "remoteBranch">
): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (const action of CATALOGUE_REF_ACTIONS) {
    const cmvKey: CmvKey | null = REF_ACTION_CATALOGUE[action].cmvKey;
    if (cmvKey === null) continue;
    if (cmvKey.branch !== undefined) {
      keys[`ging-git-view.cmv.branch.${cmvKey.branch}`] = cmv.branch[cmvKey.branch];
    }
    if (cmvKey.remoteBranch !== undefined) {
      keys[`ging-git-view.cmv.remoteBranch.${cmvKey.remoteBranch}`] =
        cmv.remoteBranch[cmvKey.remoteBranch];
    }
  }
  return keys;
}

/** The category a branch ref falls in for `contextMenuActionsVisibility`:
 *  `branch` for local refs, `remoteBranch` for remote-tracking ones — the
 *  `remotes/` prefix decides (CONTEXT.md, "Ref 的兩種形"). */
export type BranchCmvCategory = "branch" | "remoteBranch";

/**
 * The graph webview's `visible:` gate for one catalogue action on a ref of
 * `category`, read off the action's `cmvKey`: the value of the declared
 * setting for that side, or `undefined` — no gate, always shown — when the
 * action declares no setting there (`cmvKey: null`, or a key on the other
 * side only). The webview never spells a settings key by hand for a branch
 * item; declaring the key here is what makes both menus follow it.
 */
export function refActionVisibility(
  action: CatalogueRefAction,
  category: BranchCmvCategory,
  cmv: Pick<ContextMenuActionsVisibility, BranchCmvCategory>
): boolean | undefined {
  const cmvKey: CmvKey | null = REF_ACTION_CATALOGUE[action].cmvKey;
  if (cmvKey === null) return undefined;
  if (category === "branch") {
    return cmvKey.branch === undefined ? undefined : cmv.branch[cmvKey.branch];
  }
  return cmvKey.remoteBranch === undefined ? undefined : cmv.remoteBranch[cmvKey.remoteBranch];
}

/** Why a batch action cannot apply to a branch, or null when it can. Derived
 *  from the catalogue rather than declared per action: `remote` is
 *  `refKinds: "local"` seen from a remote ref, `checkedOut` is the head guard
 *  seen from the checked-out ref — the same facts the single-action path and
 *  package.json's menu conditions enforce. */
export function batchSkipReason(
  action: BatchAction,
  branch: { isRemote: boolean; isHead: boolean }
): "checkedOut" | "remote" | null {
  const spec = REF_ACTION_CATALOGUE[action];
  if (branch.isRemote && spec.refKinds === "local") return "remote";
  if (branch.isHead && spec.headGuard) return "checkedOut";
  return null;
}
