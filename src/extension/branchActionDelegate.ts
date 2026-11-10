/**
 * The host half of the side-view branch action delegation (ADR-0010): one
 * module owns the whole path from "a context-menu command fired" to "the graph
 * webview holds the message" — target resolution, catalogue validation, the
 * head guard, ref normalisation, the seq counter and the two delivery paths.
 * Kept free of any `vscode` import so it can be unit-tested in the fast
 * backend test project, like its neighbours in this directory.
 */

import { displayRef } from "@/backend/utils/branchRef";
import {
  isHostAction,
  REF_ACTION_CATALOGUE,
  type CatalogueRefAction,
  type HostRefAction
} from "@/backend/utils/refActionCatalogue";
import type { BatchAction, BatchSkipped, BranchCleanupPayload, DelegatedMessage } from "@/types";

import type { BranchActionTarget, BranchActionTargets } from "./branchesView";

/**
 * The messages this delegate gets to the graph webview, which holds them until
 * it shows their repo with no load in flight.
 *
 * The cleanup dialog rides here with the ref actions rather than getting its own
 * delivery path: the wait-for-load race, the two delivery routes and the `seq`
 * dedupe are the same problem for all three, and a second copy of that logic is
 * how one of them ends up subtly different. Sharing the counter also means a
 * cleanup message can never be mistaken for a ref action's retry. The blame
 * hover's "locate in the graph" (#310) rides here for the same reasons: it too
 * is sent straight after the graph is opened or switched, to a panel that may
 * still be loading.
 */
export type { DelegatedMessage };

export type BranchActionDelegateDeps = {
  /** The branch a single-selection command argument points at, or null when it
   *  isn't a branch leaf ({@link branchActionTarget}). */
  resolveTarget: (item: unknown) => BranchActionTarget | null;
  /** A batch action's targets and skipped refs for a multi-selection
   *  (`branchesView.actionTargetsForSelection`). */
  resolveBatchTargets: (items: unknown[], action: BatchAction) => BranchActionTargets | null;
  /** Open/reveal the graph panel on the repo, so any confirmation appears
   *  focused. */
  openGraphView: (repo: string) => Promise<void>;
  /** Post to the live webview, if any. */
  post: (msg: DelegatedMessage) => void;
  writeClipboard: (text: string) => void;
  /** Report a batch whose every selected branch was ruled out — naming them and
   *  the reason is the whole point; "nothing happened" reads like a bug. */
  showNoTargets: (skipped: BatchSkipped[]) => void;
};

export type BranchActionDelegate = ReturnType<typeof createBranchActionDelegate>;

export function createBranchActionDelegate(deps: BranchActionDelegateDeps) {
  // The messages waiting for the graph webview to (re)load, in seq order —
  // every one of them, not just the latest (#325): two requests made while the
  // panel loads are both owed. They share one repo, as each opens the graph on
  // its own: one for another repo takes the graph away from those before it,
  // which are dropped rather than left to run whenever the user next opens
  // their repo. The webview dedupes the two delivery paths (direct post +
  // selectRepo flush) by the messages' monotonic seq, shared by every kind so
  // one can never be mistaken for another's retry.
  let pending: DelegatedMessage[] = [];
  let seq = 0;

  const flushDelegated = (repo: string): void => {
    // A selectRepo for some other repo (e.g. the user clicked around while the
    // panel opened) must not discard the messages — their own repo's load is
    // still coming, and that selectRepo will flush them.
    if (pending.length === 0 || pending[0].repo !== repo) return;
    for (const msg of pending) deps.post(msg);
    pending = [];
  };

  const deliver = async (msg: DelegatedMessage): Promise<void> => {
    // Two delivery paths: the direct post covers an open panel already showing
    // the repo (same-repo setRepo doesn't reload, so no selectRepo would fire);
    // the selectRepo flush covers fresh panels and repo switches, whose
    // in-flight load would otherwise race the message.
    pending = pending.filter((p) => p.repo === msg.repo).concat(msg);
    await deps.openGraphView(msg.repo);
    deps.post(msg);
  };

  // The actions that never leave the extension host (ADR-0009): they ask
  // nothing, so opening the graph for them would be pure cost. The clipboard
  // carries display refs, exactly as their labels read.
  const hostHandlers: Record<HostRefAction, (target: BranchActionTarget) => void> = {
    copyName: (target) => deps.writeClipboard(displayRef(target.branch))
  };
  const hostBatchHandlers: Record<HostRefAction, (targets: string[]) => void> = {
    // Tree order, one ref per line.
    copyName: (targets) => deps.writeClipboard(targets.map(displayRef).join("\n"))
  };

  /** Run a side-view context-menu action on the clicked branch. Graph actions
   *  are delegated to the webview, where the exact same flow as its own branch
   *  menu runs (dialogs included). */
  const run = async (item: unknown, action: CatalogueRefAction): Promise<void> => {
    const target = deps.resolveTarget(item);
    if (target === null) return;
    const spec = REF_ACTION_CATALOGUE[action];
    // A kind mismatch can only mean a mis-wired menu contribution — fail loud
    // at the source instead of a silent no-op at the far end (ADR-0010).
    if (spec.refKinds === (target.isRemote ? "local" : "remote")) {
      throw new Error(
        `Branch action "${action}" does not apply to ${target.isRemote ? "remote" : "local"} ref "${target.branch}"`
      );
    }
    if (isHostAction(action)) {
      hostHandlers[action](target);
      return;
    }
    // The same guard the menus express as `viewItem == branch-local`: these
    // actions never apply to the checked-out branch. Checked before opening
    // the panel, so it doesn't pop up just to do nothing.
    if (spec.headGuard && target.isCurrent) return;
    await deliver({
      command: "runRefAction",
      repo: target.repo,
      ref: target.branch,
      action,
      seq: ++seq
    });
  };

  /** Run a batch action against the whole selection. */
  const runBatch = async (items: unknown[], action: BatchAction): Promise<void> => {
    const resolved = deps.resolveBatchTargets(items, action);
    if (resolved === null) return;
    if (isHostAction(action)) {
      if (resolved.targets.length > 0) hostBatchHandlers[action](resolved.targets);
      return;
    }
    if (resolved.targets.length === 0) {
      // Every selected branch was ruled out.
      deps.showNoTargets(resolved.skipped);
      return;
    }
    await deliver({
      command: "runRefBatchAction",
      repo: resolved.repo,
      action,
      targets: resolved.targets,
      skipped: resolved.skipped,
      seq: ++seq
    });
  };

  /** Open the cleanup dialog on an already-built payload. The candidate rules
   *  and the empty-set check are the caller's (ADR-0017) — this only gets the
   *  payload there. */
  const openCleanup = async (repo: string, payload: BranchCleanupPayload): Promise<void> => {
    await deliver({ command: "showBranchCleanup", repo, payload, seq: ++seq });
  };

  /** Open the graph on `repo` and have it select and bring `hash` into view.
   *  Whether the commit is drawn, or how far to load for it, is the webview's
   *  to find out — only it knows what it has loaded. */
  const locateCommit = async (repo: string, hash: string): Promise<void> => {
    await deliver({ command: "locateCommit", repo, hash, seq: ++seq });
  };

  return { run, runBatch, openCleanup, locateCommit, flushDelegated };
}
