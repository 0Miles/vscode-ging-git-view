/**
 * The single declaration of every branch action the Branches side-view offers
 * (ADR-0010). Both halves of the delegation pipeline read it: the extension
 * host validates and routes against it before sending, the graph webview keys
 * its handler table by it. The command registrations, the wire-type unions and
 * the batch skip rules are all derived from here — adding an action means
 * adding one entry (plus its package.json menu item and webview handler).
 */

export type RefKinds = "local" | "remote" | "both";

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
};

export const REF_ACTION_CATALOGUE = {
  checkout: {
    refKinds: "both",
    headGuard: true,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  rename: {
    refKinds: "local",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  // `refKinds: "both"`: the single-selection menu only offers `delete` on local
  // branches (`deleteRemote` is the remote wording), but a batch delete accepts
  // remote-tracking refs — deleting one just takes the other git command — so
  // "delete" as an action applies to both kinds and the webview routes by the
  // ref's prefix.
  delete: { refKinds: "both", headGuard: true, batch: true, needsRemotes: false, runsIn: "graph" },
  merge: { refKinds: "both", headGuard: true, batch: false, needsRemotes: false, runsIn: "graph" },
  rebase: {
    refKinds: "local",
    headGuard: true,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  fastForward: {
    refKinds: "local",
    headGuard: true,
    batch: true,
    needsRemotes: false,
    runsIn: "graph"
  },
  push: { refKinds: "local", headGuard: false, batch: true, needsRemotes: true, runsIn: "graph" },
  createArchive: {
    refKinds: "local",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  createPullRequest: {
    refKinds: "both",
    headGuard: false,
    batch: false,
    needsRemotes: true,
    runsIn: "graph"
  },
  pull: {
    refKinds: "remote",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  fetchIntoLocal: {
    refKinds: "remote",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  deleteRemote: {
    refKinds: "remote",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  checkRedundancy: {
    refKinds: "both",
    headGuard: false,
    batch: false,
    needsRemotes: false,
    runsIn: "graph"
  },
  copyName: { refKinds: "both", headGuard: false, batch: true, needsRemotes: false, runsIn: "host" }
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
