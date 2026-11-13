/* One webview instance of the desktop host: a graph on one repository, with a
 * dispatch, ports and git client of its own over the services every instance
 * shares (sharedServices.ts). The main process opens one today; #393's tabs open
 * one each (#388). */

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { pickBootRepo } from "@ging/core/backend/utils/repoPath";
import { createFetchService } from "@ging/core/extension/fetchService";
import { buildGraphViewState } from "@ging/core/extension/graphViewState";
import { registerMessageHandlers } from "@ging/core/extension/messageHandler";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";
import { SequenceEditorManager } from "@ging/core/extension/sequenceEditor/sequenceEditorManager";
import { type WebviewChannel, webviewBridgeFactory } from "@ging/core/extension/webviewBridge";
import type { Prompts, RepoSource } from "@ging/core/host/ports";
import { createDesktopWatcher } from "@ging/desktop/ports/watcher";
import type { SharedServices } from "@ging/desktop/sharedServices";
import type { GitGraphViewState } from "@ging/shared/types";

type GraphInstanceOptions = {
  /** The repository it opens on, already checked (`repoToOpen`). */
  repo: string;
  /** Its page. */
  channel: WebviewChannel;
  /** Asks in its own window: a prompt git raises comes back here. */
  prompts: Prompts;
};

export type GraphInstance = {
  /** The view state its page boots with, built anew for each load of the page. */
  pageViewState(): GitGraphViewState;
  /** Its page is loading anew (a reload): the graph in it has yet to pick its
   *  repository, which the dispatch must bind again rather than take as
   *  already bound. */
  pageLoading(): void;
  dispose(): void;
};

export function createGraphInstance(
  shared: SharedServices,
  { repo, channel, prompts }: GraphInstanceOptions
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

  /** What #391 brings; until then said in the log, since nothing else will. */
  const notYet = (what: string) => logger.logError(`${what} is not available yet (#391)`);
  const dispatch = registerMessageHandlers(
    bridge,
    {
      config,
      prompts,
      opener: shared.opener,
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
      onSelectRepo: (selected) => {
        current = selected;
      },
      // The side-view's branch actions are delegated to the graph in VS Code;
      // here the side-view is in the same page (#399), so nothing is held.
      onDelegatedRan: () => {},
      showAllBranches: async () => notYet("Show All"),
      configurePullRequestProvider: () => notYet("Configuring a pull request provider"),
      openScmView: () => notYet("The source control view")
    }
  );

  return {
    pageViewState: () =>
      buildGraphViewState({ config, repoSource, extensionState: shared.extensionState }),
    pageLoading: dispatch.onPanelShown,
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
