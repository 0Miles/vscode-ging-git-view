/**
 * Every fetch GING runs: the git call and its prune flags (ADR-0012), plus the
 * entry points that reach it from outside the graph's webview bridge — the
 * `fetch` and `fetchRemote` commands, the auto-fetch timer and the fetch of one
 * listed remote — which run inside the host's `runRepoMutation`. The graph's
 * own fetches take the git call alone; the bridge's `mutatesRepo` already
 * wraps them, and the two must not nest.
 *
 * The timer is Node's `setInterval`, not a host port. Restarting it when its
 * settings change is the host's business.
 */

import type { SimpleGit } from "simple-git";

import { fetchFromRemotes, fetchRemote as gitFetchRemote } from "@ging/core/backend/actions/fetch";
import { type NetworkGit, stoppableNetworkCommands } from "@ging/core/backend/gitRun";
import {
  type CommandKitDeps,
  createMutatingCommandKit,
  type MutationDeps
} from "@ging/core/extension/commandKit";
import type { HostConfig, Prompts } from "@ging/core/host/ports";

export type FetchServiceDeps = CommandKitDeps &
  MutationDeps & {
    config: Pick<
      HostConfig,
      "fetchAndPrune" | "fetchAndPruneTags" | "autoFetchEnabled" | "autoFetchIntervalMinutes"
    >;
    prompts: Pick<Prompts, "showError" | "showInformation" | "pick">;
    /** How the commands' and the timer's fetches spawn git, and the signal
     *  that stops them (#450): once it aborts, a fetch running is sent a kill
     *  aimed at everything it started (best-effort, ADR-0028), none starts
     *  again, and the timer is stopped. Without it they run on
     *  `gitClientFor`'s client, which nothing stops. */
    networkGit?: NetworkGit;
  };

export type FetchService = ReturnType<typeof createFetchService>;

const FETCH_FAILED = "error.unableToFetch";

export function createFetchService(deps: FetchServiceDeps) {
  const { config, prompts, l10n } = deps;
  const net = deps.networkGit;
  /** The commands' and the timer's client: its fetches through `networkGit`
   *  when there is one. */
  const gitClientFor = (repo: string | null): SimpleGit => {
    const git = deps.gitClientFor(repo);
    return net === undefined || repo === null
      ? git
      : stoppableNetworkCommands(git, () => repo, net);
  };
  const kit = createMutatingCommandKit({ ...deps, gitClientFor });
  const pruneFlags = () => ({
    prune: config.fetchAndPrune(),
    pruneTags: config.fetchAndPruneTags()
  });

  /** Every remote of the repo `git` is bound to. */
  const fetchAll = (git: SimpleGit): Promise<void> => fetchFromRemotes(git, pruneFlags());
  /** One named remote. */
  const fetchRemote = (git: SimpleGit, remote: string): Promise<void> =>
    gitFetchRemote(git, { remote, ...pruneFlags() });

  let autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  /** A tick's fetch still running: the next tick skips rather than stack a
   *  second one, whose finish would unmute the watcher under the first. */
  let autoFetchInFlight = false;
  const stopAutoFetch = () => {
    if (autoFetchTimer !== undefined) clearInterval(autoFetchTimer);
    autoFetchTimer = undefined;
  };
  const aborted = () => net?.signal?.aborted === true;
  net?.signal?.addEventListener("abort", stopAutoFetch, { once: true });

  return {
    /** The git call alone, for a caller whose channel already mutes the watcher
     *  and refreshes afterwards — the graph's Fetch button and the cleanup
     *  dialog, behind the bridge's `mutatesRepo`. Rejects on failure; the
     *  caller reports it. */
    fetchAll,

    /** The `fetch` command: every remote of the current repository. No
     *  repository, or a failure, is a notification. */
    async fetchCommand(): Promise<void> {
      const repo = kit.currentRepoOrSay();
      if (repo !== null) await kit.mutateOrToast(FETCH_FAILED, repo, fetchAll);
    },

    /** The `fetchRemote` command: one remote of the current repository — the
     *  only one without asking, or the one picked. No repository, no remotes,
     *  or a failure, is a notification. */
    async fetchRemoteCommand(): Promise<void> {
      const repo = kit.currentRepoOrSay();
      if (repo === null) return;
      const remotes = await kit.listRemotesOrToast(FETCH_FAILED, repo);
      if (remotes === undefined) return;
      if (remotes.length === 0) {
        prompts.showInformation(l10n.t("fetch.noRemotes"));
        return;
      }
      const remote =
        remotes.length === 1
          ? remotes[0].name
          : await prompts.pick(
              remotes.map(({ name }) => ({ label: name, value: name })),
              { placeholder: l10n.t("fetch.pickRemote") }
            );
      if (remote === undefined) return;
      await kit.mutateOrToast(FETCH_FAILED, repo, (git) => fetchRemote(git, remote));
    },

    /** The fetch of one listed remote, from the host's menu on it. A failure
     *  is a toast. */
    fetchOneCommand: (repo: string, remote: string): Promise<void> =>
      kit.mutateOrToast(FETCH_FAILED, repo, (git) => fetchRemote(git, remote)),

    /** Re-arm the auto-fetch timer from the settings as they are now: off, or
     *  every remote of the current repository each 1–60 minutes. Silent — no
     *  repository, offline, or no remotes must not nag every few minutes. */
    restartAutoFetch(): void {
      stopAutoFetch();
      if (aborted() || !config.autoFetchEnabled()) return;
      const minutes = Math.min(60, Math.max(1, config.autoFetchIntervalMinutes()));
      autoFetchTimer = setInterval(
        () => {
          const repo = kit.currentRepo();
          if (repo === null || autoFetchInFlight) return;
          autoFetchInFlight = true;
          deps
            .runRepoMutation(repo, () => fetchAll(gitClientFor(repo)))
            .catch(() => {
              /* best-effort: stay silent on failure */
            })
            .finally(() => {
              autoFetchInFlight = false;
            });
        },
        minutes * 60 * 1000
      );
    },

    /** Stop the timer. */
    dispose: stopAutoFetch
  };
}
