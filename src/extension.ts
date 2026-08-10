import type { SimpleGit } from "simple-git";
import * as vscode from "vscode";

import { AvatarManager } from "./avatarManager";
import { createBranch } from "./backend/actions/branch";
import { resetToCommit } from "./backend/actions/commit";
import { fetchFromRemotes, fetchRemote, listRemoteNames } from "./backend/actions/fetch";
import {
  addRemote,
  getRemoteUrl,
  removeRemote,
  renameRemote,
  setRemoteUrl
} from "./backend/actions/remote";
import { getUserDetails, setUserDetails } from "./backend/actions/userDetails";
import { gitClientFactory } from "./backend/gitClient";
import { getCommitFileContent } from "./backend/queries/commitFileContent";
import { loadDanglingCommits, loadReflog } from "./backend/queries/loadReflog";
import { loadStatistics } from "./backend/queries/loadStatistics";
import { displayRef } from "./backend/utils/branchRef";
import { formatGitError } from "./backend/utils/gitError";
import { buildExtensionUri, getPathFromUri } from "./backend/utils/path";
import { CATALOGUE_REF_ACTIONS, isBatchAction } from "./backend/utils/refActionCatalogue";
import { repoContainingPath, resolveToKnownRepo } from "./backend/utils/repoMatch";
import { config, SCM_SELECTION_MODE_SETTING } from "./config";
import { decodeDiffDocUri, DiffDocProvider } from "./diffDocProvider";
import { AskpassManager } from "./extension/askpass/askpassManager";
import { createBranchActionDelegate } from "./extension/branchActionDelegate";
import { createBranchDataService } from "./extension/branchDataService";
import { branchActionTarget, createBranchesView } from "./extension/branchesView";
import { createBranchFilterStore } from "./extension/branchFilterStore";
import {
  findGraphTabs,
  GRAPH_VIEW_TYPE,
  mayOpenGraphUnprompted
} from "./extension/graphPanelWindow";
import { createLogger } from "./extension/logger";
import { registerMessageHandlers } from "./extension/messageHandler";
import { type ConfigScope, runPruneTagsMigration } from "./extension/pruneTagsMigration";
import {
  createRemotesView,
  remoteActionTarget,
  type RemoteActionTarget
} from "./extension/remotesView";
import { createRepoManager } from "./extension/repoManager";
import { createScmRepoTracker } from "./extension/scmRepoTracker";
import { showStatistics } from "./extension/statisticsPanel";
import { WebviewBridge, webviewBridgeFactory } from "./extension/webviewBridge";
import { createWebviewPanel, WebviewPanel } from "./extension/webviewPanel";
import { createRepoSearch } from "./extension/workspaceSearch";
import { createRepoWatcher } from "./extension/workspaceWatcher";
import { ExtensionState } from "./extensionState";
import * as l10n from "./l10n";
import { initL10n } from "./l10n";
import { RepoFileWatcher } from "./repoFileWatcher";
import { StatusBarItem } from "./statusBarItem";
import type { BatchSkipped } from "./types";

export function activate(context: vscode.ExtensionContext) {
  initL10n(context.extensionPath);
  const outputChannel = vscode.window.createOutputChannel(l10n.t("outputChannel.text"));
  const logger = createLogger(outputChannel);
  const extensionState = new ExtensionState(context);
  // One-off, before anything can fetch: `fetch.prune` now defaults on, which
  // would arm a `fetch.pruneTags` that had been inert and start deleting local
  // tags for a user who changed nothing. Turn it back off for them (ADR-0012).
  const pruneTagsTargets: Record<ConfigScope, vscode.ConfigurationTarget> = {
    global: vscode.ConfigurationTarget.Global,
    workspace: vscode.ConfigurationTarget.Workspace,
    workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder
  };
  void runPruneTagsMigration({
    inspect: (key) => vscode.workspace.getConfiguration("ging-git-view").inspect(key),
    disablePruneTags: (scope) =>
      vscode.workspace
        .getConfiguration("ging-git-view")
        .update("fetch.pruneTags", false, pruneTagsTargets[scope]),
    hasRun: () => extensionState.isPruneTagsMigrationDone(),
    markRun: () => extensionState.setPruneTagsMigrationDone(),
    notify: () =>
      void vscode.window
        .showInformationMessage(l10n.t("fetch.pruneTagsDisabled"), l10n.t("fetch.openSettings"))
        .then((choice) => {
          if (choice !== undefined) {
            void vscode.commands.executeCommand("ging-git-view.openExtensionSettings");
          }
        })
  });
  const avatarManager = new AvatarManager(config.gitPath, extensionState);
  const statusBarItem = new StatusBarItem(context, config);
  // Prompt for remote credentials when git asks: the askpass env is
  // passed only to this client's git children, never onto the shared host env.
  const askpassManager = new AskpassManager();
  context.subscriptions.push(askpassManager);
  const gitClient = gitClientFactory(
    extensionState.getLastActiveRepo() ?? "",
    config.gitPath(),
    logger.logCmd,
    askpassManager.getEnv()
  );
  const repoManager = createRepoManager(extensionState, statusBarItem, config);
  const repoSearch = createRepoSearch(repoManager, config);
  const repoWatcher = createRepoWatcher(repoManager, config, repoSearch);
  const scmRepoTracker = createScmRepoTracker();
  let currentPanel: WebviewPanel | undefined;
  let currentBridge: WebviewBridge | undefined;

  // Branches side-view: a native TreeView (in the Source Control container) that
  // replaces the in-graph branch dropdown. Its selection drives a per-repo
  // filter — the single source of truth shared with the graph panel; its data
  // comes from a service decoupled from the panel's `gitClient` so it can read
  // and operate on the active repo without racing the panel.
  const branchFilterStore = createBranchFilterStore();
  const branchDataService = createBranchDataService({
    gitPath: config.gitPath,
    gitEnv: askpassManager.getEnv()
  });
  // "Show remote branches" is a per-repo setting (persisted in repoManager);
  // fall back to the global default. The side-view's toggle is now the sole
  // control for it (the graph's checkbox was removed).
  const resolveShowRemote = (repo: string): boolean =>
    repoManager.getRepos()[repo]?.showRemoteBranches ?? config.showRemoteBranches();
  // "Show inactive branches" is likewise a per-repo toggle, falling back to the
  // global default. Branches idle beyond `inactiveBranchThresholdDays` are
  // hidden unless this is on (or they're exempt — head/selected/always-show).
  const resolveShowInactive = (repo: string): boolean =>
    repoManager.getRepos()[repo]?.showInactiveBranches ?? config.showInactiveBranchesByDefault();
  // "Show merged branches" is the second, independent hide toggle: branches
  // already merged into the repo's default branch. Same per-repo shape, same
  // exemptions (head / selected / always-show).
  const resolveShowMerged = (repo: string): boolean =>
    repoManager.getRepos()[repo]?.showMergedBranches ?? config.showMergedBranchesByDefault();
  const branchesView = createBranchesView({
    dataService: branchDataService,
    filterStore: branchFilterStore,
    resolveShowRemote,
    resolveShowInactive,
    resolveShowMerged,
    resolveInactiveThresholdDays: config.inactiveBranchThresholdDays,
    resolveExemptPatterns: config.inactiveBranchAlwaysShow
  });
  branchesView.setActiveRepo(extensionState.getLastActiveRepo());
  context.subscriptions.push(branchesView, branchFilterStore);

  // Remotes side-view: a flat list of the active repo's remotes, sharing the
  // Branches view's data service and repo-following behaviour. Mutations are
  // registered as commands below.
  const remotesView = createRemotesView(branchDataService);
  remotesView.setActiveRepo(extensionState.getLastActiveRepo());
  context.subscriptions.push(remotesView);

  // Mirror the graph's context-menu visibility settings onto when-clause
  // context keys, so the side-view's branch menu shows the same items.
  const syncBranchMenuVisibility = () => {
    const cmv = config.contextMenuActionsVisibility();
    const set = (key: string, value: boolean) =>
      void vscode.commands.executeCommand("setContext", "ging-git-view.cmv." + key, value);
    set("branch.checkout", cmv.branch.checkout);
    set("branch.rename", cmv.branch.rename);
    set("branch.push", cmv.branch.push);
    set("branch.createArchive", cmv.branch.createArchive);
    set("branch.delete", cmv.branch.delete);
    set("branch.merge", cmv.branch.merge);
    set("branch.rebase", cmv.branch.rebase);
    set("branch.checkRedundancy", cmv.branch.checkRedundancy);
    set("branch.copyName", cmv.branch.copyName);
    set("remoteBranch.checkout", cmv.remoteBranch.checkout);
    set("remoteBranch.merge", cmv.remoteBranch.merge);
    set("remoteBranch.pull", cmv.remoteBranch.pull);
    set("remoteBranch.fetch", cmv.remoteBranch.fetch);
    set("remoteBranch.delete", cmv.remoteBranch.delete);
    set("remoteBranch.checkRedundancy", cmv.remoteBranch.checkRedundancy);
    set("remoteBranch.copyName", cmv.remoteBranch.copyName);
  };
  syncBranchMenuVisibility();

  /**
   * Build a side-view visibility toggle for the active repo. Each is bound to
   * both its Show and its Hide command — the title button swaps between the two
   * by state — flips the per-repo override (falling back to the global default
   * when unset), persists it, and re-lists the view.
   */
  const makeVisibilityToggle = (
    field: "showRemoteBranches" | "showInactiveBranches" | "showMergedBranches",
    globalDefault: () => boolean,
    onToggled?: (next: boolean) => void
  ) => {
    return (): void => {
      const repo = branchesView.getActiveRepo();
      if (repo === null) return;
      const state = repoManager.getRepos()[repo];
      if (state === undefined) return;
      const next = !(state[field] ?? globalDefault());
      repoManager.setRepoState(repo, { ...state, [field]: next });
      branchesView.refresh();
      onToggled?.(next);
    };
  };

  const toggleRemoteBranches = makeVisibilityToggle(
    "showRemoteBranches",
    config.showRemoteBranches,
    // The only one the graph cares about: it decides which refs `git log` walks.
    (next) => currentBridge?.post({ command: "setShowRemoteBranches", value: next })
  );
  // Side-view only. The graph neither hides inactive branches nor hides merged
  // ones — it dims the merged refs' chips instead, driven by the load response.
  const toggleInactiveBranches = makeVisibilityToggle(
    "showInactiveBranches",
    config.showInactiveBranchesByDefault
  );
  // Deliberately separate from the inactive toggle (ADR-0004): the two rules
  // classify opposite things — a merged branch is safe to forget, an idle
  // unmerged one is work you forgot — so they get one switch each.
  const toggleMergedBranches = makeVisibilityToggle(
    "showMergedBranches",
    config.showMergedBranchesByDefault
  );

  void (async () => {
    repoManager.removeReposNotInWorkspace();
    if (!(await repoManager.checkReposExist())) repoManager.sendRepos();
    await repoSearch.searchWorkspaceForRepos();
    repoWatcher.startWatching();
    logger.log(
      "Searched workspace for repositories (found " +
        Object.keys(repoManager.getRepos()).length +
        ")"
    );
  })();

  // Mirror VSCode's built-in git discovery into repoManager so the Graph webview
  // (which lives behind repoManager) can switch to any repo the user selects in the
  // Source Control view. We only ADD — never remove — to avoid stomping on repoManager's
  // own discovery.
  const mirrorBuiltinIntoRepoManager = () => {
    const existing = repoManager.getRepos();
    let changed = false;
    for (const repoPath of scmRepoTracker.getRepoPaths()) {
      if (!existing[repoPath]) {
        repoManager.addRepo(repoPath);
        changed = true;
      }
    }
    if (changed) repoManager.sendRepos();
  };
  context.subscriptions.push(scmRepoTracker.onDidChangeRepos(mirrorBuiltinIntoRepoManager));
  mirrorBuiltinIntoRepoManager();

  // Publish the SC-focused repos so the `scm/repository` row button can show itself on just those
  // rows (`scmProviderRootUri in ...`). Deliberately NOT gated on followSourceControlSelection: that
  // setting only decides whether we auto-open the graph, while the button is the manual affordance
  // someone who turned it off still needs. `onDidChangeSelection` stays silent for the startup
  // selection, so `onDidChangeRepos` — which fires after the tracker captures it — seeds the key.
  const syncFocusedRepoContext = () => {
    void vscode.commands.executeCommand(
      "setContext",
      "ging-git-view.focusedRepoUris",
      scmRepoTracker.getSelectedRepoUris()
    );
  };
  context.subscriptions.push(
    scmRepoTracker.onDidChangeSelection(syncFocusedRepoContext),
    scmRepoTracker.onDidChangeRepos(syncFocusedRepoContext)
  );
  syncFocusedRepoContext();

  // The graph offers its repo dropdown only while the Source Control view is in multi-select mode.
  // Which repos are ticked there is not readable by extensions (it lives in workbench storage), but
  // the mode itself is an ordinary setting, so follow that.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SCM_SELECTION_MODE_SETTING)) return;
      currentBridge?.post({
        command: "setScmMultiRepoSelection",
        enabled: config.scmMultiRepoSelection()
      });
    })
  );

  // Map raw repo paths (e.g. from the SC selection) to the repos repoManager knows, resolving
  // symlinks and dropping any it hasn't discovered.
  const toKnownRepos = (paths: string[]): string[] => {
    const known = Object.keys(repoManager.getRepos());
    return paths
      .map((p) => resolveToKnownRepo(p, known) ?? p)
      .filter((p) => repoManager.getRepos()[p] !== undefined);
  };

  // Restored panels carry the roots they were created with, which point into
  // the previous install directory once the extension updates — so every panel,
  // fresh or restored, is handed these again rather than trusting what it woke
  // up with.
  const graphWebviewOptions = (): vscode.WebviewOptions => ({
    enableScripts: true,
    localResourceRoots: [
      buildExtensionUri(context.extensionPath, "media"),
      buildExtensionUri(context.extensionPath, "out")
    ]
  });

  // Turn a raw webview panel into *the* graph panel: one bridge, one set of
  // message handlers, one file watcher, all torn down together when it closes.
  // Two panels reach here — one this extension just created, one VSCode
  // restored after a host restart — and they must be wired identically, or the
  // restored one comes back inert and the next open piles a second tab on top.
  const adoptPanel = (panel: vscode.WebviewPanel) => {
    let bridge!: WebviewBridge;
    const repoFileWatcher = new RepoFileWatcher(() => {
      if (panel.visible) {
        bridge.post({ command: "refresh" });
        branchesView.refresh();
        remotesView.refresh();
      }
    });
    bridge = webviewBridgeFactory(panel.webview, repoFileWatcher);
    currentBridge = bridge;
    avatarManager.registerBridge(bridge.post.bind(bridge));
    const messageHandlers = registerMessageHandlers(bridge, {
      config,
      gitClient,
      repoManager,
      extensionState,
      avatarManager,
      repoFileWatcher,
      branchFilterStore,
      onSelectRepo: (repo) => {
        branchesView.setActiveRepo(repo);
        remotesView.setActiveRepo(repo);
        // The webview is alive and (re)loading this repo: deliver any waiting
        // side-view action now (the webview holds it until the load lands).
        branchActionDelegate.flushPendingRefAction(repo);
      }
    });
    currentPanel = createWebviewPanel({
      panel,
      bridge,
      config,
      repoFileWatcher,
      extensionPath: context.extensionPath,
      extensionState,
      avatarManager,
      repoManager,
      onDispose: () => {
        currentPanel = undefined;
        currentBridge = undefined;
        messageHandlers.dispose();
      },
      onPanelShown: messageHandlers.onPanelShown
    });
  };

  // Open (or reveal) the Graph panel, optionally switching it to a specific repo.
  // `targetRepoPath` is the repo to focus: supplied by the plugin sidebar's repo
  // row and by the native SCM view's title icon (its SourceControl rootUri).
  // When given, the graph switches to that repo even if a panel is already open;
  // without it we fall back to the last active / active-editor repo.
  const openGraphView = async (targetRepoPath?: string) => {
    const activeEditor = vscode.window.activeTextEditor;
    const column = activeEditor?.viewColumn;

    // An explicit target (sidebar row / SCM icon) wins; map it through any
    // symlink to the matching known repo. Otherwise optionally open to the repo
    // containing the active editor's file.
    let repoToOpen =
      targetRepoPath !== undefined
        ? (resolveToKnownRepo(targetRepoPath, Object.keys(repoManager.getRepos())) ??
          targetRepoPath)
        : undefined;
    if (
      repoToOpen === undefined &&
      config.openToTheRepoOfActiveEditor() &&
      activeEditor !== undefined
    ) {
      const filePath = getPathFromUri(activeEditor.document.uri);
      const repo = repoContainingPath(filePath, Object.keys(repoManager.getRepos()));
      if (repo !== null) repoToOpen = repo;
    }
    // Persist first so a freshly-created panel reads the right repo during its
    // initial `loadRepos` handshake — avoids racing the webview boot.
    if (repoToOpen) extensionState.setLastActiveRepo(repoToOpen);
    branchesView.setActiveRepo(repoToOpen ?? extensionState.getLastActiveRepo());
    remotesView.setActiveRepo(repoToOpen ?? extensionState.getLastActiveRepo());

    const hadPanel = currentPanel !== undefined;
    if (currentPanel) {
      currentPanel.reveal(column);
    } else {
      // No panel of ours, yet the window may still show graph tabs VSCode
      // restored and has not offered to the serializer (it defers that until a
      // tab first becomes visible). Take their place rather than adding to
      // them: open where the first one sat, then close the lot.
      const strayTabs = findGraphTabs(vscode.window.tabGroups.all);
      const panel = vscode.window.createWebviewPanel(
        GRAPH_VIEW_TYPE,
        l10n.t("outputChannel.text"),
        strayTabs[0]?.group.viewColumn ?? column ?? vscode.ViewColumn.One,
        { ...graphWebviewOptions(), retainContextWhenHidden: config.retainContextWhenHidden() }
      );
      adoptPanel(panel);
      // Keep the focus on the panel just opened, not on whatever sat behind a
      // closing tab.
      if (strayTabs.length > 0) void vscode.window.tabGroups.close(strayTabs, true);
    }

    // For an explicit target on an already-open panel, `loadRepos` alone won't
    // switch (it keeps a still-valid current repo), so follow up with `setRepo`
    // which unconditionally swaps. A fresh panel picks up the repo via its boot
    // handshake from the persisted lastActiveRepo above.
    if (targetRepoPath && repoToOpen && hadPanel && currentBridge) {
      currentBridge.post({
        command: "loadRepos",
        repos: repoManager.getRepos(),
        lastActiveRepo: repoToOpen
      });
      currentBridge.post({ command: "setRepo", repo: repoToOpen });
    }
  };

  // VSCode persists the graph tab across an extension-host restart and hands it
  // back here when it next becomes visible. Without this the restored tab is
  // one nobody owns: `currentPanel` starts every activation as `undefined`, so
  // the next open added a second tab beside it, one more on every restart.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(GRAPH_VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        // A window with no folder open is not one GING puts a graph in on its
        // own; and a panel already adopted is the one that stays. Either way the
        // restored tab goes, rather than lingering as a second graph.
        if (currentPanel || !mayOpenGraphUnprompted(vscode.workspace.workspaceFolders)) {
          panel.dispose();
          return Promise.resolve();
        }
        // Only `WebviewOptions` can be reasserted here; `retainContextWhenHidden`
        // is fixed at creation, so a restored panel keeps the value it was
        // serialized with until the tab is closed and opened again.
        panel.webview.options = graphWebviewOptions();
        adoptPanel(panel);
        return Promise.resolve();
      }
    })
  );

  // Clear out the pile this bug already left behind: a window that restarted a
  // few times before the serializer existed comes back with several restored
  // graph tabs. Keep the first — it is the one the serializer will adopt — and
  // close the rest, which are inert either way.
  const restoredGraphTabs = findGraphTabs(vscode.window.tabGroups.all);
  if (restoredGraphTabs.length > 1) {
    void vscode.window.tabGroups.close(restoredGraphTabs.slice(1), true);
  }

  // The same "skipped, because X" lines the batch confirmation dialog shows,
  // for the case where nothing is left to confirm and there is no dialog.
  const skippedNotes = (skipped: BatchSkipped[]): string[] =>
    (
      [
        ["checkedOut", "dialog.batch.skippedCheckedOut"],
        ["remote", "dialog.batch.skippedRemote"]
      ] as const
    ).flatMap(([reason, key]) => {
      const refs = skipped.filter((s) => s.reason === reason).map((s) => displayRef(s.ref));
      return refs.length === 0 ? [] : [l10n.t(key, refs.join(", "))];
    });

  // Side-view branch actions, single and batch, all go through the one
  // delegate (ADR-0010): it validates against the shared action catalogue,
  // applies the head guard, and delivers graph-bound actions to the webview
  // over its two deduped paths — where the exact same flow as the in-graph
  // branch menu runs (dialogs included).
  const branchActionDelegate = createBranchActionDelegate({
    resolveTarget: branchActionTarget,
    resolveBatchTargets: branchesView.actionTargetsForSelection,
    openGraphView,
    post: (msg) => currentBridge?.post(msg),
    writeClipboard: (text) => void vscode.env.clipboard.writeText(text),
    showNoTargets: (skipped) =>
      void vscode.window.showInformationMessage(
        [l10n.t("branchView.batch.noTargets"), ...skippedNotes(skipped)].join(" ")
      )
  });

  // Run a Remotes side-view action against its repo's git instance, then
  // refresh everything that may show remote state: both side-views (remote
  // renames/removals change remote-tracking refs) and an open graph.
  const runRemoteAction = async (
    item: unknown,
    errorKey: string,
    action: (git: SimpleGit, target: RemoteActionTarget) => Promise<void>
  ): Promise<void> => {
    const target = remoteActionTarget(item);
    if (target === null) return;
    try {
      await action(branchDataService.getGitInstance(target.repo), target);
      remotesView.refresh();
      branchesView.refresh();
      currentBridge?.post({ command: "refresh" });
    } catch (e: unknown) {
      void vscode.window.showErrorMessage(l10n.t(errorKey) + ": " + formatGitError(e));
    }
  };

  // Follow the repo focused in the native Source Control view (`Repository.ui.selected`, which the
  // git API drives from the single focused repo). Open the graph on it, or switch an already-open
  // graph to it in place, revealing the graph panel so it gains focus. Only the selection already
  // in place when the tracker binds is silent; on a cold start that is usually nothing, so this
  // does fire during startup — see the note on `createScmRepoTracker`.
  context.subscriptions.push(
    scmRepoTracker.onDidChangeSelection((selectedPaths) => {
      if (!config.followSourceControlSelection()) return;
      const selected = toKnownRepos(selectedPaths);
      if (selected.length === 0) return;
      branchesView.setActiveRepo(selected[0]);
      remotesView.setActiveRepo(selected[0]);
      if (!currentPanel) {
        // Following may open the graph, and an empty window is no place to open
        // one uninvited — the built-in git extension finds repos there too.
        if (mayOpenGraphUnprompted(vscode.workspace.workspaceFolders)) {
          void openGraphView(selected[0]);
        }
        return;
      }
      // Persist first: a hidden panel drops the posts below (no live webview without
      // retainContextWhenHidden) and reloads its HTML on reveal, booting from the stored
      // lastActiveRepo — without this it would come back showing the previous repo.
      extensionState.setLastActiveRepo(selected[0]);
      // `loadRepos` refreshes the repo set; `setRepo` then switches unconditionally (it alone won't,
      // as it keeps a still-valid current repo). Then reveal the panel to bring the graph to the
      // front and focus it on the newly-selected repo.
      currentBridge?.post({
        command: "loadRepos",
        repos: repoManager.getRepos(),
        lastActiveRepo: selected[0]
      });
      currentBridge?.post({ command: "setRepo", repo: selected[0] });
      currentPanel.reveal();
    })
  );

  // The native SCM view (title icon, and the repository context menu in the
  // Source Control Repositories view) invokes `view` with the git SourceControl
  // whose `rootUri` is the repo root; surface that path so the graph opens for
  // that repo (matching a click on the plugin sidebar's repo row). Other callers
  // (status bar, command palette) pass nothing.
  const scmRepoPathFromArg = (arg: unknown): string | undefined => {
    if (typeof arg === "object" && arg !== null && "rootUri" in arg) {
      const rootUri = (arg as { rootUri?: vscode.Uri }).rootUri;
      if (rootUri) return getPathFromUri(rootUri);
    }
    return undefined;
  };

  // Auto-fetch: periodically fetch all remotes when enabled, then refresh an
  // open graph. Best-effort and silent — failures (offline, no remotes) must
  // not nag the user.
  let autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  const restartAutoFetch = () => {
    if (autoFetchTimer !== undefined) {
      clearInterval(autoFetchTimer);
      autoFetchTimer = undefined;
    }
    if (!config.autoFetchEnabled()) return;
    const minutes = Math.min(60, Math.max(1, config.autoFetchIntervalMinutes()));
    autoFetchTimer = setInterval(
      () => {
        void (async () => {
          try {
            await fetchFromRemotes(gitClient.getInstance(), {
              prune: config.fetchAndPrune(),
              pruneTags: config.fetchAndPruneTags()
            });
            currentBridge?.post({ command: "refresh" });
          } catch {
            /* best-effort: stay silent on failure */
          }
        })();
      },
      minutes * 60 * 1000
    );
  };
  restartAutoFetch();
  context.subscriptions.push({
    dispose: () => {
      if (autoFetchTimer !== undefined) clearInterval(autoFetchTimer);
    }
  });

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand("ging-git-view.view", (arg?: unknown) =>
      openGraphView(scmRepoPathFromArg(arg))
    ),
    vscode.commands.registerCommand("ging-git-view.sidebar.openGraph", (rawRepoPath?: string) =>
      openGraphView(rawRepoPath)
    ),
    // --- Branches side-view commands ---
    vscode.commands.registerCommand("ging-git-view.branches.search", () =>
      branchesView.searchBranch()
    ),
    vscode.commands.registerCommand("ging-git-view.branches.collapseAll", () =>
      branchesView.collapseFolders()
    ),
    vscode.commands.registerCommand("ging-git-view.branches.refresh", () => branchesView.refresh()),
    vscode.commands.registerCommand("ging-git-view.branches.showAll", () => {
      const repo = branchesView.getActiveRepo();
      if (repo === null) return;
      branchFilterStore.set(repo, []); // graph: show all
      branchesView.clearSelection(); // side-view: clear the visual selection
    }),
    // The title button shows whichever of these matches the current state.
    vscode.commands.registerCommand(
      "ging-git-view.branches.showRemoteBranches",
      toggleRemoteBranches
    ),
    vscode.commands.registerCommand(
      "ging-git-view.branches.hideRemoteBranches",
      toggleRemoteBranches
    ),
    // Likewise, the title button swaps between these by the showingInactive state.
    vscode.commands.registerCommand("ging-git-view.branches.showInactive", toggleInactiveBranches),
    vscode.commands.registerCommand("ging-git-view.branches.hideInactive", toggleInactiveBranches),
    vscode.commands.registerCommand("ging-git-view.branches.showMerged", toggleMergedBranches),
    vscode.commands.registerCommand("ging-git-view.branches.hideMerged", toggleMergedBranches),
    // Side-view branch actions, generated from the shared action catalogue
    // (ADR-0010) — an entry there is what makes a command exist, so the two
    // can never drift apart. The command IDs follow the one convention:
    // `branches.<action>`, plus `branches.<action>Selected` for actions that
    // run against a multi-selection (package.json swaps the menu between them
    // on `listMultiSelection`).
    ...CATALOGUE_REF_ACTIONS.flatMap((action) => {
      const commands = [
        vscode.commands.registerCommand(`ging-git-view.branches.${action}`, (item: unknown) =>
          branchActionDelegate.run(item, action)
        )
      ];
      if (isBatchAction(action)) {
        commands.push(
          vscode.commands.registerCommand(
            `ging-git-view.branches.${action}Selected`,
            (item: unknown, items?: unknown[]) =>
              branchActionDelegate.runBatch(items ?? [item], action)
          )
        );
      }
      return commands;
    }),
    // --- Remotes side-view commands ---
    vscode.commands.registerCommand("ging-git-view.remotes.refresh", () => remotesView.refresh()),
    vscode.commands.registerCommand("ging-git-view.remotes.add", async () => {
      const repo = remotesView.getActiveRepo();
      if (repo === null) return;
      const name = (
        await vscode.window.showInputBox({
          prompt: l10n.t("remotes.namePrompt"),
          ignoreFocusOut: true
        })
      )?.trim();
      if (!name) return;
      const url = (
        await vscode.window.showInputBox({
          prompt: l10n.t("remotes.urlPrompt"),
          ignoreFocusOut: true
        })
      )?.trim();
      if (!url) return;
      try {
        await addRemote(branchDataService.getGitInstance(repo), { name, url });
        remotesView.refresh();
        branchesView.refresh();
        currentBridge?.post({ command: "refresh" });
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(
          l10n.t("error.unableToManageRemote") + ": " + formatGitError(e)
        );
      }
    }),
    vscode.commands.registerCommand("ging-git-view.remotes.editUrl", (item: unknown) =>
      runRemoteAction(item, "error.unableToManageRemote", async (git, target) => {
        const url = (
          await vscode.window.showInputBox({
            prompt: l10n.t("remotes.urlPrompt"),
            value: target.fetchUrl,
            ignoreFocusOut: true
          })
        )?.trim();
        if (!url || url === target.fetchUrl) return; // cancelled / unchanged
        await setRemoteUrl(git, { name: target.name, url });
      })
    ),
    vscode.commands.registerCommand("ging-git-view.remotes.rename", (item: unknown) =>
      runRemoteAction(item, "error.unableToManageRemote", async (git, target) => {
        const newName = (
          await vscode.window.showInputBox({
            prompt: l10n.t("remotes.renamePrompt"),
            value: target.name,
            ignoreFocusOut: true
          })
        )?.trim();
        if (!newName || newName === target.name) return; // cancelled / unchanged
        await renameRemote(git, { oldName: target.name, newName });
      })
    ),
    vscode.commands.registerCommand("ging-git-view.remotes.remove", (item: unknown) =>
      runRemoteAction(item, "error.unableToManageRemote", async (git, target) => {
        const yes = l10n.t("remotes.removeConfirmYes");
        const confirm = await vscode.window.showWarningMessage(
          l10n.t("remotes.removeConfirm", target.name),
          { modal: true },
          yes
        );
        if (confirm !== yes) return; // cancelled
        await removeRemote(git, { name: target.name });
      })
    ),
    vscode.commands.registerCommand("ging-git-view.remotes.fetchOne", (item: unknown) =>
      runRemoteAction(item, "error.unableToFetch", (git, target) =>
        fetchRemote(git, {
          remote: target.name,
          prune: config.fetchAndPrune(),
          pruneTags: config.fetchAndPruneTags()
        })
      )
    ),
    vscode.commands.registerCommand("ging-git-view.remotes.copyUrl", (item: unknown) => {
      const target = remoteActionTarget(item);
      if (target !== null) void vscode.env.clipboard.writeText(target.fetchUrl);
    }),
    vscode.commands.registerCommand("ging-git-view.clearAvatarCache", () => {
      avatarManager.clearCache();
    }),
    vscode.commands.registerCommand("ging-git-view.fetch", async () => {
      try {
        await fetchFromRemotes(gitClient.getInstance(), {
          prune: config.fetchAndPrune(),
          pruneTags: config.fetchAndPruneTags()
        });
        // Refresh an open graph so the freshly-fetched refs show immediately.
        currentBridge?.post({ command: "refresh" });
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(
          l10n.t("error.unableToFetch") + ": " + formatGitError(e)
        );
      }
    }),
    vscode.commands.registerCommand("ging-git-view.manageRemotes", async () => {
      // View/add/edit/delete remotes; offered as a command since neo has
      // no settings widget.
      const git = gitClient.getInstance();
      try {
        const remotes = await listRemoteNames(git);
        const addLabel = l10n.t("remotes.add");
        const choice = await vscode.window.showQuickPick([...remotes, addLabel], {
          placeHolder: l10n.t("remotes.pickPrompt")
        });
        if (choice === undefined) return;
        if (choice === addLabel) {
          const name = await vscode.window.showInputBox({
            prompt: l10n.t("remotes.namePrompt"),
            ignoreFocusOut: true
          });
          if (!name) return;
          const url = await vscode.window.showInputBox({
            prompt: l10n.t("remotes.urlPrompt"),
            ignoreFocusOut: true
          });
          if (url === undefined) return;
          await addRemote(git, { name: name.trim(), url: url.trim() });
        } else {
          const editUrl = l10n.t("remotes.editUrl");
          const rename = l10n.t("remotes.rename");
          const remove = l10n.t("remotes.remove");
          const action = await vscode.window.showQuickPick([editUrl, rename, remove], {
            placeHolder: l10n.t("remotes.actionPrompt", choice)
          });
          if (action === undefined) return;
          if (action === editUrl) {
            const url = await vscode.window.showInputBox({
              prompt: l10n.t("remotes.urlPrompt"),
              value: await getRemoteUrl(git, choice),
              ignoreFocusOut: true
            });
            if (url === undefined) return;
            await setRemoteUrl(git, { name: choice, url: url.trim() });
          } else if (action === rename) {
            const newName = await vscode.window.showInputBox({
              prompt: l10n.t("remotes.renamePrompt"),
              value: choice,
              ignoreFocusOut: true
            });
            if (!newName || newName.trim() === choice) return;
            await renameRemote(git, { oldName: choice, newName: newName.trim() });
          } else {
            const yes = l10n.t("remotes.removeConfirmYes");
            const confirm = await vscode.window.showWarningMessage(
              l10n.t("remotes.removeConfirm", choice),
              { modal: true },
              yes
            );
            if (confirm !== yes) return;
            await removeRemote(git, { name: choice });
          }
        }
        remotesView.refresh();
        branchesView.refresh();
        currentBridge?.post({ command: "refresh" });
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(
          l10n.t("error.unableToManageRemote") + ": " + (e instanceof Error ? e.message : String(e))
        );
      }
    }),
    vscode.commands.registerCommand("ging-git-view.fetchRemote", async () => {
      // Fetch a single chosen remote, offered as a command.
      try {
        const git = gitClient.getInstance();
        const remotes = await listRemoteNames(git);
        if (remotes.length === 0) {
          void vscode.window.showInformationMessage(l10n.t("fetch.noRemotes"));
          return;
        }
        const remote =
          remotes.length === 1
            ? remotes[0]
            : await vscode.window.showQuickPick(remotes, {
                placeHolder: l10n.t("fetch.pickRemote")
              });
        if (remote === undefined) return; // cancelled
        await fetchRemote(git, {
          remote,
          prune: config.fetchAndPrune(),
          pruneTags: config.fetchAndPruneTags()
        });
        currentBridge?.post({ command: "refresh" });
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(
          l10n.t("error.unableToFetch") + ": " + formatGitError(e)
        );
      }
    }),
    vscode.commands.registerCommand("ging-git-view.viewReflog", async () => {
      // Browse the reflog (and commits dangling beyond it) and recover any of
      // them. A command + QuickPick, since neo has no settings widget.
      const git = gitClient.getInstance();
      try {
        const [reflog, dangling] = await Promise.all([loadReflog(git), loadDanglingCommits(git)]);
        const entries = [...reflog, ...dangling];
        if (entries.length === 0) {
          void vscode.window.showInformationMessage(l10n.t("reflog.empty"));
          return;
        }
        const danglingTag = l10n.t("reflog.danglingTag");
        const pick = await vscode.window.showQuickPick(
          entries.map((e) => ({
            label: `${e.dangling ? "$(warning) " : ""}${e.shortHash}  ${e.subject}`,
            description: e.dangling ? danglingTag : e.selector,
            entry: e
          })),
          { placeHolder: l10n.t("reflog.pickPrompt"), matchOnDescription: true }
        );
        if (pick === undefined) return; // cancelled
        const hash = pick.entry.hash;
        const createBranchLabel = l10n.t("reflog.createBranch");
        const resetLabel = l10n.t("reflog.resetHard");
        const copyLabel = l10n.t("reflog.copyHash");
        const action = await vscode.window.showQuickPick(
          [createBranchLabel, resetLabel, copyLabel],
          { placeHolder: l10n.t("reflog.actionPrompt", pick.entry.shortHash) }
        );
        if (action === undefined) return;
        if (action === createBranchLabel) {
          const name = (
            await vscode.window.showInputBox({
              prompt: l10n.t("reflog.branchNamePrompt"),
              ignoreFocusOut: true
            })
          )?.trim();
          if (!name) return;
          await createBranch(git, {
            commitHash: hash,
            branchName: name,
            checkout: false,
            force: false
          });
        } else if (action === resetLabel) {
          const yes = l10n.t("reflog.resetConfirmYes");
          const confirm = await vscode.window.showWarningMessage(
            l10n.t("reflog.resetConfirm", pick.entry.shortHash),
            { modal: true },
            yes
          );
          if (confirm !== yes) return;
          await resetToCommit(git, { commitHash: hash, resetMode: "hard" });
        } else {
          await vscode.env.clipboard.writeText(hash);
        }
        currentBridge?.post({ command: "refresh" });
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(l10n.t("reflog.unableTo") + ": " + formatGitError(e));
      }
    }),
    vscode.commands.registerCommand("ging-git-view.showStatistics", async () => {
      // Open a read-only stats panel (commits by author + activity heatmap).
      try {
        const stats = await loadStatistics(gitClient.getInstance());
        showStatistics(stats);
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(l10n.t("stats.unableTo") + ": " + formatGitError(e));
      }
    }),
    vscode.commands.registerCommand("ging-git-view.exportRepoConfig", () => {
      // Export the repo's GING config to a committable .vscode file.
      const repo = extensionState.getLastActiveRepo();
      const repos = repoManager.getRepos();
      if (!repo || !repos[repo]) {
        void vscode.window.showInformationMessage(l10n.t("repoName.noRepos"));
        return;
      }
      const error = repoManager.exportRepoConfig(repo);
      if (error === null) {
        void vscode.window.showInformationMessage(l10n.t("exportConfig.done"));
      } else {
        void vscode.window.showErrorMessage(l10n.t("exportConfig.failed") + ": " + error);
      }
    }),
    vscode.commands.registerCommand("ging-git-view.toggleRemoteVisibility", async () => {
      // Show/hide the branches of individual remotes for the current repo.
      const repo = extensionState.getLastActiveRepo();
      const repos = repoManager.getRepos();
      if (!repo || !repos[repo]) {
        void vscode.window.showInformationMessage(l10n.t("repoName.noRepos"));
        return;
      }
      const remotes = await listRemoteNames(gitClient.getInstance());
      if (remotes.length === 0) {
        void vscode.window.showInformationMessage(l10n.t("fetch.noRemotes"));
        return;
      }
      const hidden = repos[repo].hiddenRemotes ?? [];
      const picked = await vscode.window.showQuickPick(
        remotes.map((r) => ({ label: r, picked: !hidden.includes(r) })),
        { canPickMany: true, placeHolder: l10n.t("remoteVisibility.prompt") }
      );
      if (picked === undefined) return; // cancelled
      const visible = new Set(picked.map((p) => p.label));
      const newHidden = remotes.filter((r) => !visible.has(r));
      repoManager.setRepoState(repo, { ...repos[repo], hiddenRemotes: newHidden });
      repoManager.sendRepos();
      currentBridge?.post({ command: "refresh" });
    }),
    vscode.commands.registerCommand("ging-git-view.setRepoName", async () => {
      // Custom display name for a repo in the Repo dropdown; a command
      // since neo has no settings widget.
      const repos = repoManager.getRepos();
      const repoPaths = Object.keys(repos);
      if (repoPaths.length === 0) {
        void vscode.window.showInformationMessage(l10n.t("repoName.noRepos"));
        return;
      }
      const repo =
        repoPaths.length === 1
          ? repoPaths[0]
          : await vscode.window.showQuickPick(repoPaths, {
              placeHolder: l10n.t("repoName.pickPrompt")
            });
      if (repo === undefined) return;
      const name = await vscode.window.showInputBox({
        prompt: l10n.t("repoName.prompt"),
        value: repos[repo].customName ?? "",
        ignoreFocusOut: true
      });
      if (name === undefined) return; // cancelled
      const trimmed = name.trim();
      repoManager.setRepoState(repo, {
        ...repos[repo],
        customName: trimmed === "" ? null : trimmed
      });
      repoManager.sendRepos();
    }),
    vscode.commands.registerCommand("ging-git-view.openExtensionSettings", () => {
      // Quick access to this extension's settings.
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:0miles.ging-git-view"
      );
    }),
    vscode.commands.registerCommand("ging-git-view.setGitUserDetails", async () => {
      // neo has no Settings Widget; the local/global user name & email are set
      // through this command instead.
      const git = gitClient.getInstance();
      const current = await getUserDetails(git);
      const name = await vscode.window.showInputBox({
        prompt: l10n.t("userDetails.namePrompt"),
        value: current.name,
        ignoreFocusOut: true
      });
      if (name === undefined) return; // cancelled
      const email = await vscode.window.showInputBox({
        prompt: l10n.t("userDetails.emailPrompt"),
        value: current.email,
        ignoreFocusOut: true
      });
      if (email === undefined) return;
      const localLabel = l10n.t("userDetails.scopeLocal");
      const globalLabel = l10n.t("userDetails.scopeGlobal");
      const scope = await vscode.window.showQuickPick([localLabel, globalLabel], {
        placeHolder: l10n.t("userDetails.scopePrompt")
      });
      if (scope === undefined) return;
      try {
        await setUserDetails(git, {
          name: name.trim(),
          email: email.trim(),
          useGlobal: scope === globalLabel
        });
        void vscode.window.showInformationMessage(l10n.t("userDetails.updated"));
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(
          l10n.t("userDetails.unableToSet") + ": " + (e instanceof Error ? e.message : String(e))
        );
      }
    }),
    vscode.commands.registerCommand("ging-git-view.getVersionInfo", async () => {
      let gitVersion = "git: unknown";
      try {
        gitVersion = (await gitClient.getInstance().raw(["--version"])).trim();
      } catch {
        /* git not available; report what we can */
      }
      const info = [
        "GING: " + context.extension.packageJSON.version,
        "Visual Studio Code: " + vscode.version,
        "OS: " + process.platform + " " + process.arch,
        gitVersion
      ].join("\n");
      const copy = await vscode.window.showInformationMessage(
        info,
        { modal: true },
        l10n.t("versionInfo.copy")
      );
      if (copy !== undefined) await vscode.env.clipboard.writeText(info);
    }),
    vscode.commands.registerCommand("ging-git-view.openFileFromDiff", (uri?: vscode.Uri) => {
      // Opens the working-tree version of the file shown in a GING diff
      // editor. `uri` is supplied by the editor/title menu; fall back to the
      // active editor.
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target === undefined || target.scheme !== DiffDocProvider.scheme) return;
      const { repo, filePath } = decodeDiffDocUri(target);
      void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(`${repo}/${filePath}`), {
        preview: true
      });
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      DiffDocProvider.scheme,
      new DiffDocProvider((repo, commit, filePath) =>
        getCommitFileContent(
          config.gitPath(),
          repo,
          commit,
          filePath,
          // Resolve fileEncoding at the repo's Workspace Folder scope.
          config.fileEncoding(vscode.Uri.file(repo))
        )
      )
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ging-git-view.showStatusBarItem")) {
        statusBarItem.refresh();
      } else if (e.affectsConfiguration("ging-git-view.maxDepthOfRepoSearch")) {
        repoSearch.maxDepthChanged();
      } else if (e.affectsConfiguration("git.path")) {
        gitClient.setGitPath(config.gitPath());
      } else if (e.affectsConfiguration("ging-git-view.autoFetch")) {
        restartAutoFetch();
      } else if (e.affectsConfiguration("ging-git-view.branches")) {
        // Threshold / always-show / default-visibility changes re-classify the
        // side-view's inactive branches.
        branchesView.refresh();
      } else if (e.affectsConfiguration("ging-git-view.contextMenuActions")) {
        // Keep the side-view's branch menu in step with the graph's menu.
        syncBranchMenuVisibility();
      }
    }),
    repoWatcher,
    scmRepoTracker
  );

  logger.log("Extension activated successfully");
}

export function deactivate() {}
