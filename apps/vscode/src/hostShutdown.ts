/**
 * What the extension's deactivation does to the git it left running (#450):
 * the signal its fetches run under is aborted, which sends each of them a kill
 * (best-effort, ADR-0028), and deactivation waits a bounded while for them to
 * go. On Windows each kill is a `taskkill` of its own, which an extension host
 * exiting at once would cut short, leaving git on the network — the desktop
 * host's quit waits the same way (`SharedServices.stoppingGits`).
 *
 * No `vscode` here, so it is tested on its own; `extension.ts` starts one in
 * `activate` and its `deactivate` is `deactivateHost`.
 */

import { createStoppedGits, type NetworkGit } from "@ging/core/backend/gitRun";
import {
  createFetchService,
  type FetchService,
  type FetchServiceDeps
} from "@ging/core/extension/fetchService";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";
import type { RunRepoMutation, Watcher } from "@ging/core/host/ports";

/** How long deactivation waits for the stopped gits: well under the 5 s
 *  VS Code gives every extension's `deactivate` in all. */
export const DEACTIVATE_WAITS_FOR_GIT_MS = 3_000;

export type HostShutdown = {
  /** Aborted on deactivation. */
  signal: AbortSignal;
  /** For `NetworkGit.onAborted`: a git the signal stopped, until it has gone. */
  onAborted(exited: Promise<void>): void;
  /** Abort the signal, then wait for every git it stopped, or `timeoutMs`. */
  shutDown(timeoutMs?: number): Promise<void>;
};

export function createHostShutdown(): HostShutdown {
  const controller = new AbortController();
  const stopped = createStoppedGits();
  return {
    signal: controller.signal,
    onAborted: stopped.add,
    shutDown(timeoutMs = DEACTIVATE_WAITS_FOR_GIT_MS) {
      controller.abort();
      // A run the abort just stopped hands its `exited` over once its own
      // await resumes: a turn of the queue later, so look after that.
      return new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
        stopped.ended(timeoutMs)
      );
    }
  };
}

/**
 * The extension's fetch service and its `runRepoMutation`, both under the
 * shutdown `activate` starts (`startHostShutdown`): what deactivation aborts
 * is what their git runs under, and what it waits for is what their stopped
 * git hands back. The extension's, not a graph panel's: these run for the
 * side views and commands with no graph open, so closing the panel stops none
 * of them.
 */
export function createShutDownFetching(deps: {
  watcher: () => Pick<Watcher, "mute" | "unmute"> | undefined;
  afterMutation: () => void;
  fetch: Omit<FetchServiceDeps, "runRepoMutation" | "networkGit">;
  networkGit: Omit<NetworkGit, "signal" | "onAborted">;
}): { runRepoMutation: RunRepoMutation; fetchService: FetchService } {
  const shutdown = startHostShutdown();
  const runRepoMutation = createRunRepoMutation({
    watcher: deps.watcher,
    afterMutation: deps.afterMutation,
    signal: shutdown.signal
  });
  const fetchService = createFetchService({
    ...deps.fetch,
    runRepoMutation,
    networkGit: { ...deps.networkGit, signal: shutdown.signal, onAborted: shutdown.onAborted }
  });
  return { runRepoMutation, fetchService };
}

let current: HostShutdown | undefined;

/** The one `activate` starts: what its fetches run under. */
export function startHostShutdown(): HostShutdown {
  current = createHostShutdown();
  return current;
}

/** The extension's `deactivate`: shut down what `activate` started. */
export function deactivateHost(): Promise<void> {
  const shutdown = current;
  current = undefined;
  return shutdown?.shutDown() ?? Promise.resolve();
}
