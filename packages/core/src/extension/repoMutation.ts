import { GitAbortedError } from "@ging/core/backend/utils/gitError";
import type { RunRepoMutation, Watcher } from "@ging/core/host/ports";

/**
 * A Host's `runRepoMutation`, for the repo changes made outside the graph's
 * webview bridge: mute the open graph's file watcher, run the work,
 * unmute it, then refresh. The refresh is the reliable signal, not the watcher
 * (ADR-0013) — it runs with no graph open, or one hidden, whose watcher is not
 * watching at all.
 *
 * Shared by both Hosts: VS Code hands it the open graph's watcher, the desktop
 * host each webview instance's own.
 *
 * Not merged with the bridge's mutation hook: that one runs after every graph
 * mutation, and this refresh may redraw more (in VS Code, the Remotes view).
 */
export function createRunRepoMutation(deps: {
  /** The open graph's file watcher; `undefined` with no graph open. */
  watcher: () => Pick<Watcher, "mute" | "unmute"> | undefined;
  /** Invalidate and redraw whatever may show the refs just changed. */
  afterMutation: () => void;
  /** Aborted once whatever started the work is gone — the instance disposed
   *  of, the extension deactivated (#450). Work asked for after that never
   *  starts, and rejects with `GitAbortedError`; a git running inside the work
   *  is stopped by the same signal, handed to its spawn (`NetworkGit`). Nothing
   *  is refreshed after an aborted run: there is no surface left to redraw. */
  signal?: AbortSignal;
}): RunRepoMutation {
  // No use for the repo: `afterMutation` refreshes every surface, whichever
  // repo each one shows.
  return async (_repo, work) => {
    if (deps.signal?.aborted === true) throw new GitAbortedError("repo mutation");
    // The watcher muted is the one unmuted, even if the graph closes or is
    // replaced while the work runs.
    const watcher = deps.watcher();
    // The mute is a flag, not a count: whichever unmute comes first lifts it.
    // So this must never wrap work the bridge's `mutatesRepo` already mutes
    // around — the dispatch's fetches take the git call alone for that reason —
    // and two of these overlapping lift each other's mute early. The auto-fetch
    // timer skips a tick while its last fetch runs; a timed fetch overlapping a
    // graph mutation can still refresh once more than needed, which is accepted
    // (#351).
    watcher?.mute();
    try {
      await work();
    } finally {
      watcher?.unmute();
      if (deps.signal?.aborted !== true) deps.afterMutation();
    }
  };
}
