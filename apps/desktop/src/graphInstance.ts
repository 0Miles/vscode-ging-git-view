/* One webview instance of the desktop host: a graph on one repository, with a
 * dispatch, ports and git client of its own over the services every instance
 * shares (sharedServices.ts). Each Tab opens one (#388, #393). */

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { isGitRepository } from "@ging/core/backend/utils/git";
import { createFetchService } from "@ging/core/extension/fetchService";
import { buildGraphViewState } from "@ging/core/extension/graphViewState";
import {
  type MessageHandlerDeps,
  registerMessageHandlers
} from "@ging/core/extension/messageHandler";
import { createReflogCommand } from "@ging/core/extension/reflogCommand";
import { createRemoteCommands } from "@ging/core/extension/remoteCommands";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";
import { SequenceEditorManager } from "@ging/core/extension/sequenceEditor/sequenceEditorManager";
import { type WebviewChannel, webviewBridgeFactory } from "@ging/core/extension/webviewBridge";
import { createWorkingTreeService } from "@ging/core/extension/workingTreeService";
import type { Prompts, RepoSource } from "@ging/core/host/ports";
import { createShowDiff, type ShowDiff } from "@ging/desktop/diffViewer";
import { createDesktopOpener } from "@ging/desktop/ports/opener";
import { createDesktopWatcher } from "@ging/desktop/ports/watcher";
import type { GitGraphViewState, GitRepoSet, ResponseMessage } from "@ging/shared/types";
import type { ShowDiffMessage } from "@ging/webview/desktop/diff/protocol";
import {
  isWorkingTreeRequest,
  type WorkingTreeMessage,
  type WorkingTreeRequest
} from "@ging/webview/desktop/workingTree/protocol";

import { type AppCommands, createAppCommands } from "./appCommands";
import { pushSettingChange } from "./settingsPush";
import type { SharedServices } from "./sharedServices";
import { answerWorkingTree, workingTreeStrings } from "./workingTree";

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
  /** Hand its page a diff to show (#404), beside the graph's own messages
   *  (ADR-0031); false when the page is gone. */
  postDiff: (message: ShowDiffMessage) => boolean;
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
  /** What the application menu runs on it (#390, #396). */
  commands: InstanceCommands;
  /** Open its page's working tree panel (#403), as the graph's Open Source
   *  Control View does: for the application menu to offer. */
  showWorkingTree(): void;
  /** Show a diff in its page, over its graph (#404): what the working tree
   *  panel (#403) or a file's history (#408) opens a diff of its repository
   *  with. The `Opener`'s two diffs go the same way. */
  showDiff: ShowDiff;
  dispose(): void;
};

/** Core's command services on an instance's current repository, asking in its
 *  page: the application menu's graph entries, and the app's own as asked
 *  from there. */
export type InstanceCommands = AppCommands & {
  fetch(): Promise<void>;
  /** Asks which remote when there are several. */
  fetchRemote(): Promise<void>;
  manageRemotes(): Promise<void>;
  toggleRemoteVisibility(): Promise<void>;
  viewReflog(): Promise<void>;
  /** The system's terminal in the repository, named after its folder as the
   *  graph's own Terminal button names it. */
  openTerminal(): void;
};

export function createGraphInstance(
  shared: SharedServices,
  { repo, channel: page, prompts, extensionState, revealSetting, postDiff }: GraphInstanceOptions
): GraphInstance {
  const { config, l10n, logger, branchFacts, avatarManager } = shared;
  /** This instance's current repository, its Tab's, for as long as it lives. */
  const current = repo;

  // And should the page still ask for another — it was shown none, but a
  // page is not to be taken at its word — the dispatch never hears it: the
  // Tab would end up on a repository another Tab may have open.
  // The working tree panel's requests are not the graph's: answered here, by
  // core's working tree service, and never handed to the dispatch (ADR-0031).
  const channel: WebviewChannel = {
    postMessage: (message) => page.postMessage(message),
    onDidReceiveMessage: (listener) =>
      page.onDidReceiveMessage((message) => {
        if (isWorkingTreeRequest(message)) return answerPanel(message);
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
  /** Its changes made outside the bridge: muted, then refreshed, as the
   *  bridge's own are. */
  const runRepoMutation = createRunRepoMutation({ watcher: () => watcher, afterMutation: refresh });

  // What core's command services need of it: they change its repository
  // muted and refreshed around each change, as the bridge's own changes are.
  const kitDeps = {
    prompts,
    l10n,
    gitClientFor: gitClients.gitClientFor,
    currentRepo: () => current,
    repoSource: shared.repoSource,
    runRepoMutation
  };
  // Its own auto-fetch timer, on its own current repository.
  const fetchService = createFetchService({ ...kitDeps, config });
  fetchService.restartAutoFetch();

  // The working tree panel's (#403): its stage, unstage and commit refresh
  // the graph after them, so a commit shows up there.
  const workingTree = createWorkingTreeService({
    git: () => gitClient.getInstance(),
    repo: () => current,
    signCommits: () => config.signCommits(),
    runRepoMutation
  });
  /** What the panel and the host say to each other is no `ResponseMessage`:
   *  posted past the type, as the host prompts are (ADR-0031). */
  const postToPanel = (message: WorkingTreeMessage) =>
    void page.postMessage(message as unknown as ResponseMessage);
  const panelStrings = workingTreeStrings(l10n, process.platform);
  const answerPanel = async (request: WorkingTreeRequest) =>
    postToPanel(await answerWorkingTree(workingTree, panelStrings, request));

  // A Tab is one repository, and a repository is open in at most one Tab
  // (GLOSSARY.md; `branchFilterStore` counts on it). So the graph is shown
  // its own repository alone out of the known set — no other to boot on when
  // its own leaves the set, as `pickBootRepo` would fall back to; none in a
  // repo dropdown; no sub-repository to switch to (#155) — and the known set
  // itself stays the app's.
  const own = (repos: GitRepoSet): GitRepoSet =>
    Object.hasOwn(repos, repo) ? { [repo]: repos[repo] } : {};
  const known = () => Object.hasOwn(shared.repoSource.getRepos(), repo);
  const repoSource: RepoSource = {
    ...shared.repoSource,
    getRepos: () => own(shared.repoSource.getRepos()),
    getBootRepo: () => (known() ? repo : null),
    // Its own repository alone, as with the rest (#394): the app's check would
    // drop every known repository git cannot reach now — the recent list's
    // folders on a disk not mounted at the moment among them — when only this
    // Tab's graph failed to load. Whether its own should go is #454's.
    checkReposExist: async () => {
      if (!known() || (await isGitRepository(repo, shared.gitPath()))) return false;
      logger.log(`tabs: ${repo} is no Git repository any more, dropped from the known set`);
      shared.repoSource.dropRepo(repo);
      return true;
    }
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
  // Its diffs are shown in its own page.
  const showDiff = createShowDiff({
    gitPath: shared.gitPath,
    fileEncoding: config.fileEncoding,
    l10n,
    post: postDiff
  });
  const opener = createDesktopOpener({
    ...notifier,
    os: shared.os,
    // Files and terminals are opened from its Tab's repository, and no other.
    repoRoot: () => current,
    showDiff,
    platform: process.platform,
    env: process.env
  });
  // Asked in this instance's page — Manage Pull Request Providers too, as the
  // failed Create Pull Request that offers it was.
  const appCommands = createAppCommands(shared, {
    prompts,
    currentRepo: () => current,
    gitClientFor: gitClients.gitClientFor,
    revealSetting
  });
  const remoteCommands = createRemoteCommands({
    ...kitDeps,
    refreshGraph: () => void bridge.post({ command: "refresh" })
  });
  const reflog = createReflogCommand({ ...kitDeps, clipboard: shared.clipboard });
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
      configurePullRequestProvider: (host) => void appCommands.managePullRequestProviders(host),
      // The host's own source control view is the working tree panel beside
      // the graph, in the same page (#403).
      openScmView: () => postToPanel({ command: "workingTreeShow" })
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
    showDiff,
    commands: {
      ...appCommands,
      fetch: () => fetchService.fetchCommand(),
      fetchRemote: () => fetchService.fetchRemoteCommand(),
      manageRemotes: () => remoteCommands.manageRemotes(),
      toggleRemoteVisibility: () => remoteCommands.toggleRemoteVisibility(),
      viewReflog: () => reflog.viewReflog(),
      openTerminal: () => {
        const name = current.split("/").findLast((s) => s !== "") ?? current;
        opener.openTerminal(current, `GING: ${name}`);
      }
    },
    showWorkingTree: () => postToPanel({ command: "workingTreeShow" }),
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
