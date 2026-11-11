/**
 * Every fetch GING runs: the git call and its prune flags (ADR-0012), plus the
 * entry points that reach it from outside the graph's webview bridge — the
 * `fetch` and `fetchRemote` commands, the auto-fetch timer and the Remotes
 * view's fetch — which run inside the host's `runRepoMutation`. The graph's
 * own fetches take the git call alone; the bridge's `mutatesRepo` already
 * wraps them, and the two must not nest (see the VS Code host's
 * `createRunRepoMutation`).
 *
 * The timer is Node's `setInterval`, not a host port. Restarting it when its
 * settings change is the host's business.
 */

import type { SimpleGit } from "simple-git";

import {
  fetchFromRemotes,
  fetchRemote as gitFetchRemote,
  listRemoteNames
} from "@ging/core/backend/actions/fetch";
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
  prompts: Pick<Prompts, "showError" | "showInformation" | "pick">;
  l10n: L10n;
  gitClientFor: (repo: string) => SimpleGit;
  /** The current repository (`CONTEXT.md`) — what the `fetch` and
   *  `fetchRemote` commands and the timer fetch. `null` when there is none. */
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
  const fetchRemote = (git: SimpleGit, remote: string): Promise<void> =>
    gitFetchRemote(git, { remote, ...pruneFlags() });

  /** `fetch` run against `repo` inside the hook. The client is built inside it
   *  too: building one throws for a repo deleted since it was last seen. */
  const mutate = (repo: string, fetch: (git: SimpleGit) => Promise<void>) =>
    deps.runRepoMutation(repo, () => fetch(deps.gitClientFor(repo)));

  /** A failure to fetch, as a toast. */
  const toastFailure = (e: unknown) =>
    void prompts.showError(l10n.t("error.unableToFetch") + ": " + formatGitError(e));

  /** `mutate`, with a failure reported as a toast. */
  const mutateOrToast = async (repo: string, fetch: (git: SimpleGit) => Promise<void>) => {
    try {
      await mutate(repo, fetch);
    } catch (e: unknown) {
      toastFailure(e);
    }
  };

  /** The current repository, or `null` after saying there is none. */
  const currentRepoOrSay = (): string | null => {
    const repo = deps.currentRepo();
    if (repo === null) prompts.showInformation(l10n.t("repoName.noRepos"));
    return repo;
  };

  let autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  /** A tick's fetch still running: the next tick skips rather than stack a
   *  second one, whose finish would unmute the watcher under the first. */
  let autoFetchInFlight = false;
  const stopAutoFetch = () => {
    if (autoFetchTimer !== undefined) clearInterval(autoFetchTimer);
    autoFetchTimer = undefined;
  };

  return {
    /** The git call alone, for a caller whose channel already mutes the watcher
     *  and refreshes afterwards — the graph's Fetch button and the cleanup
     *  dialog, behind the bridge's `mutatesRepo`. Rejects on failure; the
     *  caller reports it. */
    fetchAll,
    /** The git call alone for one remote; see `fetchAll`. */
    fetchRemote,

    /** The `fetch` command: every remote of the current repository. No
     *  repository, or a failure, is a notification. */
    async fetchCommand(): Promise<void> {
      const repo = currentRepoOrSay();
      if (repo !== null) await mutateOrToast(repo, fetchAll);
    },

    /** The `fetchRemote` command: one remote of the current repository — the
     *  only one without asking, or the one picked. No repository, no remotes,
     *  or a failure, is a notification. */
    async fetchRemoteCommand(): Promise<void> {
      const repo = currentRepoOrSay();
      if (repo === null) return;
      let remotes: string[];
      try {
        remotes = await listRemoteNames(deps.gitClientFor(repo));
      } catch (e: unknown) {
        toastFailure(e);
        return;
      }
      if (remotes.length === 0) {
        prompts.showInformation(l10n.t("fetch.noRemotes"));
        return;
      }
      const remote =
        remotes.length === 1
          ? remotes[0]
          : await prompts.pick(
              remotes.map((name) => ({ label: name, value: name })),
              { placeholder: l10n.t("fetch.pickRemote") }
            );
      if (remote !== undefined) await mutateOrToast(repo, (git) => fetchRemote(git, remote));
    },

    /** The Remotes view's fetch: one remote of the item's repo. A failure is a
     *  toast. */
    fetchOneCommand: (repo: string, remote: string): Promise<void> =>
      mutateOrToast(repo, (git) => fetchRemote(git, remote)),

    /** Re-arm the auto-fetch timer from the settings as they are now: off, or
     *  every remote of the current repository each 1–60 minutes. Silent — no
     *  repository, offline, or no remotes must not nag every few minutes. */
    restartAutoFetch(): void {
      stopAutoFetch();
      if (!config.autoFetchEnabled()) return;
      const minutes = Math.min(60, Math.max(1, config.autoFetchIntervalMinutes()));
      autoFetchTimer = setInterval(
        () => {
          const repo = deps.currentRepo();
          if (repo === null || autoFetchInFlight) return;
          autoFetchInFlight = true;
          mutate(repo, fetchAll)
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
