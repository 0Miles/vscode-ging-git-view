/* One webview instance of the desktop host: a graph on one repository, with a
 * dispatch, ports and git client of its own over the services every instance
 * shares (sharedServices.ts). The main process opens one today; #393's tabs open
 * one each (#388). */

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { pickBootRepo } from "@ging/core/backend/utils/repoPath";
import { createFetchService } from "@ging/core/extension/fetchService";
import { buildGraphViewState } from "@ging/core/extension/graphViewState";
import { registerMessageHandlers } from "@ging/core/extension/messageHandler";
import { createPullRequestProviderCommands } from "@ging/core/extension/pullRequestProviderCommands";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";
import { SequenceEditorManager } from "@ging/core/extension/sequenceEditor/sequenceEditorManager";
import { type WebviewChannel, webviewBridgeFactory } from "@ging/core/extension/webviewBridge";
import type { Prompts, RepoSource } from "@ging/core/host/ports";
import { createDesktopOpener, notSupportedYet } from "@ging/desktop/ports/opener";
import { createDesktopWatcher } from "@ging/desktop/ports/watcher";
import type { GitGraphViewState } from "@ging/shared/types";

import { pushSettingChange } from "./settingsPush";
import type { SharedServices } from "./sharedServices";

type GraphInstanceOptions = {
  /** The repository it opens on, already checked (`repoToOpen`). */
  repo: string;
  /** Its page. */
  channel: WebviewChannel;
  /** Asks in its own window: a prompt git raises comes back here. */
  prompts: Prompts;
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
  { repo, channel, prompts, revealSetting }: GraphInstanceOptions
): GraphInstance {
  const { config, l10n, logger, branchFacts, avatarManager } = shared;
  /** This instance's current repository; the graph moves it with `selectRepo`. */
  let current = repo;

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

  // The known repositories are shared; which one the graph boots on is this
  // instance's.
  const repoSource: RepoSource = {
    ...shared.repoSource,
    getBootRepo: () => pickBootRepo(current, Object.keys(shared.repoSource.getRepos()))
  };
  const reposChanged = shared.repoSource.onDidChangeRepos((repos) => {
    void bridge.post({ command: "loadRepos", repos, lastActiveRepo: repoSource.getBootRepo() });
  });

  // Its own, so what it says is said in this instance's window.
  const notifier = { prompts, l10n, logger };
  const opener = createDesktopOpener({
    ...notifier,
    os: shared.os,
    // Files are opened from the repository the graph shows, and no other.
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
      extensionState: shared.extensionState,
      avatarManager,
      branchFilterStore: shared.branchFilterStore,
      branchFacts,
      branchCleanup: shared.branchCleanup,
      sequenceEditor,
      fetchService,
      // The five hooks into the host's other surfaces (#391). VS Code's are
      // its side-views and commands; the desktop app has none of them yet.
      // No side-view follows the graph's repository (#399): only the
      // instance's own current repository moves.
      onSelectRepo: (selected) => {
        current = selected;
      },
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
