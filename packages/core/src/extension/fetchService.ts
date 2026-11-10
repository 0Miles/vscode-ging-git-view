/**
 * Every fetch GING runs, in one place: the git call and the prune flags the
 * settings put on it (ADR-0012), and the entry points that reach it from
 * outside the graph's webview bridge.
 *
 * Where a fetch comes from decides who mutes the file watcher and refreshes
 * what showed the old refs. The graph's own fetches — its Fetch button, and the
 * cleanup dialog's fetch-first open — arrive through the bridge, whose
 * `mutatesRepo` handlers do both; they take `fetchAll` alone. The rest — the
 * `fetch` command, the auto-fetch timer and the Remotes side-view's fetch —
 * have no bridge around them, so they run inside the host's `runRepoMutation`
 * instead. Never both: the watcher's mute is a flag, not a count, so a hook
 * nested inside a bridge handler would unmute it before the handler finished.
 *
 * The timer is Node's `setInterval`, not a host port: every host GING runs in
 * is a Node process. What restarts it when its settings change is the host's
 * business.
 */

import type { SimpleGit } from "simple-git";

import { fetchFromRemotes, fetchRemote } from "@ging/core/backend/actions/fetch";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { HostConfig, L10n, Prompts } from "@ging/core/host/ports";

/** Run `work`, a change to `repo` made outside the webview bridge, the way the
 *  host runs a repo mutation: its file watcher muted across it, and whatever
 *  shows the repo refreshed once it has settled — whether or not `work` threw,
 *  since a fetch of several remotes can fail half-way. Rejects with what `work`
 *  rejected with, after that. */
export type RunRepoMutation = (repo: string, work: () => Promise<void>) => Promise<void>;

export type FetchServiceDeps = {
  config: Pick<
    HostConfig,
    "fetchAndPrune" | "fetchAndPruneTags" | "autoFetchEnabled" | "autoFetchIntervalMinutes"
  >;
  prompts: Pick<Prompts, "showError">;
  l10n: L10n;
  gitClientFor: (repo: string) => SimpleGit;
  /** The current repository (`CONTEXT.md`) — what the `fetch` command and the
   *  timer fetch. `null` when there is none, and then they fetch nothing. */
  currentRepo: () => string | null;
  runRepoMutation: RunRepoMutation;
};

export type FetchService = ReturnType<typeof createFetchService>;

export function createFetchService(deps: FetchServiceDeps) {
  const { config, prompts, l10n } = deps;
  const pruneFlags = () => ({
    prune: config.fetchAndPrune(),
    pruneTags: config.fetchAndPruneTags()
  });

  /** Every remote of the repo `git` is bound to. */
  const fetchAll = (git: SimpleGit): Promise<void> => fetchFromRemotes(git, pruneFlags());
  /** One named remote. */
  const fetchOne = (git: SimpleGit, remote: string): Promise<void> =>
    fetchRemote(git, { remote, ...pruneFlags() });

  /** `fetch` run against `repo` inside the hook. The client is built inside it
   *  too: building one throws for a repo deleted since it was last seen. */
  const mutate = (repo: string, fetch: (git: SimpleGit) => Promise<void>) =>
    deps.runRepoMutation(repo, () => fetch(deps.gitClientFor(repo)));

  const reportFailure = (e: unknown) =>
    void prompts.showError(l10n.t("error.unableToFetch") + ": " + formatGitError(e));

  let autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  const stopAutoFetch = () => {
    if (autoFetchTimer !== undefined) clearInterval(autoFetchTimer);
    autoFetchTimer = undefined;
  };

  return {
    /** The git call alone, for a caller whose channel already mutes the watcher
     *  and refreshes afterwards — the graph's Fetch button and the cleanup
     *  dialog, both behind the bridge's `mutatesRepo`. Rejects on failure; the
     *  caller reports it. */
    fetchAll,
    /** The git call alone for one remote; see `fetchAll`. */
    fetchRemote: fetchOne,

    /** The `fetch` command: every remote of the current repository. A failure
     *  is a toast. */
    async fetchCommand(): Promise<void> {
      const repo = deps.currentRepo();
      if (repo === null) return;
      try {
        await mutate(repo, fetchAll);
      } catch (e: unknown) {
        reportFailure(e);
      }
    },

    /** The Remotes side-view's fetch: one remote of the repo the item belongs
     *  to. A failure is a toast. */
    async fetchOneCommand(repo: string, remote: string): Promise<void> {
      try {
        await mutate(repo, (git) => fetchOne(git, remote));
      } catch (e: unknown) {
        reportFailure(e);
      }
    },

    /** Re-arm the auto-fetch timer from the settings as they are now: off, or
     *  every remote of the current repository each 1–60 minutes. Failures stay
     *  silent — offline, or a repo with no remotes, must not nag every few
     *  minutes. */
    restartAutoFetch(): void {
      stopAutoFetch();
      if (!config.autoFetchEnabled()) return;
      const minutes = Math.min(60, Math.max(1, config.autoFetchIntervalMinutes()));
      autoFetchTimer = setInterval(
        () => {
          const repo = deps.currentRepo();
          if (repo === null) return;
          mutate(repo, fetchAll).catch(() => {
            /* best-effort: stay silent on failure */
          });
        },
        minutes * 60 * 1000
      );
    },

    /** Stop the timer. */
    dispose: stopAutoFetch
  };
}
