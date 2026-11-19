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
  const pending = new Set<Promise<void>>();
  return {
    signal: controller.signal,
    onAborted(exited) {
      pending.add(exited);
      void exited.finally(() => pending.delete(exited));
    },
    shutDown(timeoutMs = DEACTIVATE_WAITS_FOR_GIT_MS) {
      controller.abort();
      // A run the abort just stopped hands its `exited` over once its own
      // await resumes: a turn of the queue later, so look after that.
      return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        return Promise.race([Promise.all(pending).then(() => {}), timeout]).finally(() =>
          clearTimeout(timer)
        );
      });
    }
  };
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
