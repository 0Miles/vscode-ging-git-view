/* One webview instance of the desktop host: a graph on one repository, with a
 * dispatch, ports and git client of its own over the services every instance
 * shares (sharedServices.ts). Each Tab opens one (#388, #393). */

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { createFetchService } from "@ging/core/extension/fetchService";
import { buildGraphViewState } from "@ging/core/extension/graphViewState";
import {
  type MessageHandlerDeps,
  registerMessageHandlers
} from "@ging/core/extension/messageHandler";
import { createPullRequestProviderCommands } from "@ging/core/extension/pullRequestProviderCommands";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";
import { SequenceEditorManager } from "@ging/core/extension/sequenceEditor/sequenceEditorManager";
import { type WebviewChannel, webviewBridgeFactory } from "@ging/core/extension/webviewBridge";
import type { Prompts, RepoSource } from "@ging/core/host/ports";
import { createDesktopOpener, notSupportedYet } from "@ging/desktop/ports/opener";
import { createDesktopWatcher } from "@ging/desktop/ports/watcher";
import type { GitGraphViewState, GitRepoSet } from "@ging/shared/types";

import { pushSettingChange } from "./settingsPush";
import type { SharedServices } from "./sharedServices";

type GraphInstanceOptions = {
  /** The repository it opens on, already checked (`repoToOpen`). */
  repo: string;
  /** Its page. */
  channel: WebviewChannel;
  /** Asks in its own page: a prompt git raises comes back here. */
  prompts: Prompts;
  /** Its Tab's: where its Current repository persists (`TabStates`). */
  extensionState: MessageHandlerDeps["extensionState"];
  /** Show setting `key` in the app's settings, as they are now (#397): where
   *  Manage Pull Request Providers' "show the setting" goes. */
  revealSetting: (key: string) => void;
};

export type GraphInstance = {
  /** The view state its page boots with, built anew for each load of the page. */
  pageViewState(): GitGraphViewState;
  /** Its page is loading anew (a reload): the graph in it has yet to pick its
   *  repository, which the dispatch must bind again rather than take as
   *  already bound. */
  pageLoading(): void;
  /** The host wrote setting `key` (`HostConfig.update`): react as VS Code
   *  does to a configuration change (settingsPush.ts). */
  settingChanged(key: string): void;
  /** Core's `fetchRemote` command on its current repository: asks which
   *  remote when there are several (the application menu, #390). */
  fetchRemote(): Promise<void>;
  dispose(): void;
};

export function createGraphInstance(
  shared: SharedServices,
  { repo, channel: page, prompts, extensionState, revealSetting }: GraphInstanceOptions
): GraphInstance {
  const { config, l10n, logger, branchFacts, avatarManager } = shared;
  /** This instance's current repository, its Tab's, for as long as it lives. */
  const current = repo;

  // And should the page still ask for another — it was shown none, but a
  // page is not to be taken at its word — the dispatch never hears it: the
  // Tab would end up on a repository another Tab may have open.
  const channel: WebviewChannel = {
    postMessage: (message) => page.postMessage(message),
    onDidReceiveMessage: (listener) =>
      page.onDidReceiveMessage((message) => {
        if (message.command === "selectRepo" && message.repo !== repo) {
          if (message.repo) {
            logger.log(`tabs: the Tab on ${repo} stays on it, not ${message.repo}`);
          }
          return;
        }
        return listener(message);
      })
  };

  // Its own askpass route, and its own rebase todo: two instances rebasing at
  // once must not run each other's todo, nor read each other's `wasApplied`.
  const askpass = shared.askpass.route(prompts);
  const sequenceEditor = new SequenceEditorManager(shared.helperDir);
  const gitEnv = { ...askpass.env, ...sequenceEditor.getEnv() };
  const gitClient = gitClientFactory(repo, shared.gitPath(), undefined, gitEnv);
  const gitClients = createRepoGitClients({ gitPath: shared.gitPath, gitEnv });

  /** What a change to the repository costs: every cached branch read (they
   *  are shared, see `SharedServices.branchFacts`), and a redraw of this graph. */
  const refresh = () => {
    branchFacts.invalidate();
    void bridge.post({ command: "refresh" });
  };
  const watcher = createDesktopWatcher(refresh, { onError: logger.logError });
  const bridge = webviewBridgeFactory(channel, watcher, () => branchFacts.invalidate());
  avatarManager.registerBridge(bridge.post);

  // Its own auto-fetch timer, on its own current repository, muted and
  // refreshed around each fetch as the bridge's own changes are.
  const fetchService = createFetchService({
    config,
    prompts,
    l10n,
    gitClientFor: gitClients.gitClientFor,
    currentRepo: () => current,
    repoSource: shared.repoSource,
    runRepoMutation: createRunRepoMutation({ watcher: () => watcher, afterMutation: refresh })
  });
  fetchService.restartAutoFetch();

  // A Tab is one repository, and a repository is open in at most one Tab
  // (GLOSSARY.md; `branchFilterStore` counts on it). So the graph is shown
  // its own repository alone out of the known set — no other to boot on when
  // its own leaves the set, as `pickBootRepo` would fall back to; none in a
  // repo dropdown; no sub-repository to switch to (#155) — and the known set
  // itself stays the app's.
  const own = (repos: GitRepoSet): GitRepoSet =>
    Object.hasOwn(repos, repo) ? { [repo]: repos[repo] } : {};
  const repoSource: RepoSource = {
    ...shared.repoSource,
    getRepos: () => own(shared.repoSource.getRepos()),
    getBootRepo: () => (Object.hasOwn(shared.repoSource.getRepos(), repo) ? repo : null)
  };
  const reposChanged = shared.repoSource.onDidChangeRepos((repos) => {
    void bridge.post({
      command: "loadRepos",
      repos: own(repos),
      lastActiveRepo: repoSource.getBootRepo()
    });
  });

  // Its own, so what it says is said in this instance's window.
  const notifier = { prompts, l10n, logger };
  const opener = createDesktopOpener({
    ...notifier,
    os: shared.os,
    // Files and terminals are opened from its Tab's repository, and no other.
    repoRoot: () => current,
    platform: process.platform,
    env: process.env
  });
  // Asked in this instance's page, as the failed Create Pull Request that
  // offers it was. The settings are the app's: no workspace holds any.
  const pullRequestProviders = createPullRequestProviderCommands({
    prompts,
    l10n,
    config,
    revealSetting
  });
  const dispatch = registerMessageHandlers(
    bridge,
    {
      config,
      prompts,
      opener,
      clipboard: shared.clipboard,
      watcher,
      l10n,
      repoSource,
      logger
    },
    {
      gitClient,
      extensionState,
      avatarManager,
      branchFilterStore: shared.branchFilterStore,
      branchFacts,
      branchCleanup: shared.branchCleanup,
      sequenceEditor,
      fetchService,
      // The five hooks into the host's other surfaces (#391). VS Code's are
      // its side-views and commands; the desktop app has none of them yet.
      // Only ever its own repository: see the channel above.
      onSelectRepo: () => {},
      // The side-view's branch actions are delegated to the graph in VS Code;
      // here the side-view is in the same page (#399), so nothing is held.
      onDelegatedRan: () => {},
      // Show All is the side-view's (#399). Until it is here, the graph's
      // filter chip clears nothing, and the dispatch says so to the graph
      // (`branchFilterCleared` after a Show All that moved nothing).
      showAllBranches: async () => {},
      // Core's own Manage Pull Request Providers (#398), asked in this page.
      configurePullRequestProvider: (host) => void pullRequestProviders.manage(host),
      // A stub, said to the user rather than failed, until the working
      // tree's view (#403).
      openScmView: () => notSupportedYet(notifier, "the source control view (#403)")
    }
  );

  return {
    pageViewState: () =>
      buildGraphViewState({ config, repoSource, extensionState: shared.extensionState }),
    pageLoading: dispatch.onPanelShown,
    settingChanged: (key) =>
      pushSettingChange(
        key,
        { restartAutoFetch: fetchService.restartAutoFetch, post: (msg) => void bridge.post(msg) },
        config
      ),
    fetchRemote: () => fetchService.fetchRemoteCommand(),
    dispose: () => {
      dispatch.dispose();
      reposChanged.dispose();
      fetchService.dispose();
      watcher.stop();
      avatarManager.deregisterBridge(bridge.post);
      askpass.dispose();
      sequenceEditor.dispose();
    }
  };
}
