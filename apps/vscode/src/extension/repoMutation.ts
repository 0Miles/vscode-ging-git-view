import type { RunRepoMutation } from "@ging/core/extension/fetchService";
import type { Watcher } from "@ging/core/host/ports";

/**
 * The VS Code host's `runRepoMutation`, for the repo changes made outside the
 * graph's webview bridge: mute the open graph's file watcher, run the work,
 * unmute it, then refresh. The refresh is the reliable signal, not the watcher
 * (ADR-0013) — it runs with no graph open, or one hidden, whose watcher is not
 * watching at all.
 *
 * Kept free of `vscode` so that is pinned by a unit test (ADR-0018).
 *
 * Not the bridge's mutation hook, and not merged with it: that hook runs after
 * every graph mutation, and this refresh redraws the Remotes view too, which a
 * graph mutation has no reason to.
 */
export function createRunRepoMutation(deps: {
  /** The open graph's file watcher; `undefined` with no graph open. */
  watcher: () => Pick<Watcher, "mute" | "unmute"> | undefined;
  /** Invalidate and redraw whatever may show the refs just changed. */
  afterMutation: () => void;
}): RunRepoMutation {
  // No use for the repo: `afterMutation` refreshes every surface, whichever
  // repo each one shows.
  return async (_repo, work) => {
    // The watcher muted is the one unmuted, even if the graph closes or is
    // replaced while the work runs.
    const watcher = deps.watcher();
    watcher?.mute();
    try {
      await work();
    } finally {
      watcher?.unmute();
      deps.afterMutation();
    }
  };
}
