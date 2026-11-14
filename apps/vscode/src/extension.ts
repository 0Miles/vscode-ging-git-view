import * as vscode from "vscode";

import { AvatarManager } from "@ging/core/avatarManager";
import { gitClientFactory } from "@ging/core/backend/gitClient";
import { getCommitFileContent } from "@ging/core/backend/queries/commitFileContent";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import { repoContainingPath, resolveToKnownRepo } from "@ging/core/backend/utils/repoMatch";
import { AskpassManager } from "@ging/core/extension/askpass/askpassManager";
import { createBranchActionDelegate } from "@ging/core/extension/branchActionDelegate";
import { createBranchCleanup } from "@ging/core/extension/branchCleanupService";
import { createBranchFacts, createGitSnapshotReader } from "@ging/core/extension/branchFacts";
import { createBranchFilterStore } from "@ging/core/extension/branchFilterStore";
import { createFetchService } from "@ging/core/extension/fetchService";
import { createInfoCommands } from "@ging/core/extension/infoCommands";
import { registerMessageHandlers } from "@ging/core/extension/messageHandler";
import { type ConfigScope, runPruneTagsMigration } from "@ging/core/extension/pruneTagsMigration";
import { createReflogCommand } from "@ging/core/extension/reflogCommand";
import { createRemoteCommands, type RemoteTarget } from "@ging/core/extension/remoteCommands";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";
import {
  resolveShowRemoteBranches,
  type SideViewField,
  sideViewStateChanged
} from "@ging/core/extension/repoSettings";
import { SequenceEditorManager } from "@ging/core/extension/sequenceEditor/sequenceEditorManager";
import { type WebviewBridge, webviewBridgeFactory } from "@ging/core/extension/webviewBridge";
import { ExtensionState } from "@ging/core/extensionState";
import type { HostPorts } from "@ging/core/host/ports";
import { displayRef } from "@ging/shared/backend/utils/branchRef";
import {
  branchMenuContextKeys,
  CATALOGUE_REF_ACTIONS,
  isBatchAction
} from "@ging/shared/backend/utils/refActionCatalogue";
import type { BatchSkipped, RepoSettingField } from "@ging/shared/types";

import { buildExtensionUri, getPathFromUri } from "./backend/utils/uri";
import { config, REPO_SETTING_DEFAULT_KEYS, SCM_SELECTION_MODE_SETTING } from "./config";
import { decodeDiffDocUri, DiffDocProvider } from "./diffDocProvider";
import {
  createBlameController,
  registerBlameCopySha,
  registerBlameLocateCommit,
  registerBlameOpenLineChange,
  registerBlameToggle
} from "./extension/blameController";
import { branchActionTarget, createBranchesView } from "./extension/branchesView";
import {
  findGraphTabs,
  GRAPH_VIEW_TYPE,
  mayOpenGraphUnprompted
} from "./extension/graphPanelWindow";
import { createLogger } from "./extension/logger";
import { managePullRequestProviders } from "./extension/pullRequestProviders";
import { createRemotesView, remoteActionTarget } from "./extension/remotesView";
import { createRepoManager } from "./extension/repoManager";
import { createScmRepoTracker } from "./extension/scmRepoTracker";
import { stashMenuContextKeys } from "./extension/stashActions";
import { createStashView } from "./extension/stashView";
import { showStatistics } from "./extension/statisticsPanel";
import { createWebviewPanel, WebviewPanel } from "./extension/webviewPanel";
import { createRepoSearch } from "./extension/workspaceSearch";
import { createRepoWatcher } from "./extension/workspaceWatcher";
import {
  createVscodeOpener,
  vscodeClipboard,
  vscodeL10n,
  vscodePrompts,
  vscodeStorage
} from "./hostPorts";
import * as l10n from "./l10n";
import { initL10n } from "./l10n";
import { RepoFileWatcher } from "./repoFileWatcher";
import { StatusBarItem } from "./statusBarItem";

export function activate(context: vscode.ExtensionContext) {
  initL10n(context.extensionPath);
  const outputChannel = vscode.window.createOutputChannel(l10n.t("outputChannel.text"));
  const logger = createLogger(outputChannel);
  const extensionState = new ExtensionState(vscodeStorage(context));
  // The Current repository is resolved when the state is constructed. Say which
  // path was dropped: nothing else will. The side views show their ordinary
  // "no repository selected" state, which is now true but says nothing about
  // what it used to be, and VS Code reports a failed activation to the user not
  // at all. This line is the only record that the graph once pointed at, say,
  // a `.claude/worktrees/<name>` that a tool has since removed.
  const persistedRepoPath = extensionState.getPersistedRepoPath();
  if (persistedRepoPath !== null && extensionState.getLastActiveRepo() === null) {
    logger.log(`Persisted repository is gone, starting with none selected: ${persistedRepoPath}`);
  }
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
  const avatarManager = new AvatarManager(config, extensionState);
  const statusBarItem = new StatusBarItem(context, config);
  // Prompt for remote credentials when git asks: the askpass env is
  // passed only to this client's git children, never onto the shared host env.
  // The helpers ship beside this bundle, in out/.
  const askpassManager = new AskpassManager(vscodePrompts, __dirname);
  context.subscriptions.push(askpassManager);
  // Lets a rebase run a todo the extension wrote — see sequenceEditorManager.
  const sequenceEditor = new SequenceEditorManager(__dirname);
  context.subscriptions.push(sequenceEditor);
  const gitEnv = () => ({ ...askpassManager.getEnv(), ...sequenceEditor.getEnv() });
  const gitClient = gitClientFactory(
    extensionState.getLastActiveRepo() ?? "",
    config.gitPath(),
    logger.logCmd,
    gitEnv()
  );
  const repoManager = createRepoManager(extensionState, statusBarItem, config);
  const repoSearch = createRepoSearch(repoManager, config);
  const repoWatcher = createRepoWatcher(repoManager, config, repoSearch);
  const scmRepoTracker = createScmRepoTracker();
  // Every port but the watcher, which is the panel's own (see `adoptPanel`).
  const hostPorts: Omit<HostPorts, "watcher"> = {
    config,
    prompts: vscodePrompts,
    opener: createVscodeOpener(config),
    clipboard: vscodeClipboard,
    l10n: vscodeL10n,
    repoSource: repoManager,
    logger
  };
  let currentPanel: WebviewPanel | undefined;
  let currentBridge: WebviewBridge | undefined;
  /** The open graph's file watcher, muted across the fetches made outside its
   *  bridge (see `fetchService`). */
  let currentWatcher: RepoFileWatcher | undefined;

  // Branches side-view: a native TreeView (in the Source Control container) that
  // replaces the in-graph branch dropdown. Its selection drives a per-repo
  // filter — the single source of truth shared with the graph panel; its data
  // comes from clients decoupled from the panel's `gitClient` so it can read
  // and operate on the active repo without racing the panel.
  const branchFilterStore = createBranchFilterStore();
  const repoGitClients = createRepoGitClients({
    gitPath: config.gitPath,
    gitEnv: gitEnv(),
    // Reads made outside the graph panel used to be invisible in the Output
    // Channel; now that the panel's branch load comes through here too, they
    // all have to be logged or the graph's would disappear from it.
    onCommand: logger.logCmd
  });
  // "Show remote branches" is a per-repo setting (persisted in repoManager);
  // fall back to the global default. The side-view's toggle is now the sole
  // control for it (the graph's checkbox was removed).
  const resolveShowRemote = (repo: string): boolean =>
    resolveShowRemoteBranches(repoManager.getRepos()[repo], config.showRemoteBranches());
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
  // The single holder of every branch classification fact (ADR-0013): the
  // side-view builds its tree from it and the graph's loadBranches response
  // carries the merged half of its hidable set, so the two cannot disagree.
  const branchFacts = createBranchFacts({
    readSnapshot: createGitSnapshotReader({
      gitClientFor: repoGitClients.gitClientFor,
      gitPath: config.gitPath
    }),
    filterStore: branchFilterStore,
    resolveShowRemote,
    resolveExemptPatterns: config.inactiveBranchAlwaysShow,
    resolveInactiveThresholdDays: config.inactiveBranchThresholdDays,
    resolveShowSpecificBranches: config.showSpecificBranches,
    resolveShowCurrentBranchByDefault: config.showCurrentBranchByDefault,
    nowMs: () => Date.now()
  });
  // The cleanup dialog's payload builder. Sits beside `branchFacts` for the
  // same reason the side-view does — the candidate rules read those facts, and
  // building the payload host-side is what lets an empty candidate set be
  // reported without summoning the graph panel (ADR-0017).
  const branchCleanup = createBranchCleanup({
    branchFacts,
    gitClientFor: repoGitClients.gitClientFor,
    resolveShowRemote,
    resolveExemptPatterns: config.inactiveBranchAlwaysShow,
    dateType: config.dateType
  });
  // The changes made outside the graph's bridge — the fetch, remote and reflog
  // commands, and the timer — run inside this hook, which refreshes whether or
  // not a graph is open. The graph's own fetches take the git call alone, since
  // its bridge mutes and refreshes around them.
  const runRepoMutation = createRunRepoMutation({
    watcher: () => currentWatcher,
    afterMutation: () => refreshAfterRemoteChange()
  });
  const currentRepo = () => extensionState.getLastActiveRepo();
  // Every fetch, and the auto-fetch timer.
  const fetchService = createFetchService({
    config,
    prompts: vscodePrompts,
    l10n: vscodeL10n,
    gitClientFor: repoGitClients.gitClientFor,
    currentRepo,
    repoSource: repoManager,
    runRepoMutation
  });
  fetchService.restartAutoFetch();
  context.subscriptions.push(fetchService);
  // Remote management, from the Remotes side-view and the command palette.
  const remoteCommands = createRemoteCommands({
    prompts: vscodePrompts,
    l10n: vscodeL10n,
    gitClientFor: repoGitClients.gitClientFor,
    currentRepo,
    repoSource: repoManager,
    refreshGraph: () => currentBridge?.post({ command: "refresh" }),
    runRepoMutation
  });
  const branchesView = createBranchesView({
    branchFacts,
    filterStore: branchFilterStore,
    resolveShowRemote,
    resolveShowInactive,
    resolveShowMerged,
    // The pure resolver, not `branchCleanup`: the view only needs to know which
    // leaves are candidates (to offer the menu item on them), and the service
    // would spawn git for the basis date on every reload.
    resolveExemptPatterns: config.inactiveBranchAlwaysShow
  });
  context.subscriptions.push(branchesView, branchFilterStore);
  // The side-view draws itself from three repo-state fields, and more than one
  // thing writes them: its own toggles, and the graph's Repository Settings
  // drawer (#183) through `saveRepoState`. Listening to the write itself keeps
  // the view current whichever of them it was.
  context.subscriptions.push(
    repoManager.onDidWriteRepoState((_repo, before, after) => {
      if (sideViewStateChanged(before, after)) branchesView.refresh();
    })
  );

  // Remotes side-view: a flat list of the active repo's remotes, read through
  // `remoteCommands` and following the active repo like the Branches view. Its
  // menu commands are registered below.
  const remotesView = createRemotesView(remoteCommands.list);
  context.subscriptions.push(remotesView);

  // Stash side-view: watches the stash log itself, since the graph's watcher
  // lives and dies with the panel.
  const stashView = createStashView({
    git: { gitPath: config.gitPath, gitEnv, onCommand: logger.logCmd },
    gitClients: repoGitClients,
    editorGroup: config.openNewTabEditorGroup
  });
  context.subscriptions.push(stashView);

  // Set Git User Details, Version Info and Statistics, from the command palette.
  const infoCommands = createInfoCommands({
    prompts: vscodePrompts,
    l10n: vscodeL10n,
    clipboard: vscodeClipboard,
    gitClientFor: repoGitClients.gitClientFor,
    currentRepo,
    repoSource: repoManager,
    hostVersions: [
      { name: "GING", version: context.extension.packageJSON.version },
      { name: "Visual Studio Code", version: vscode.version }
    ]
  });

  /** Point every side-view at the current repository. */
  const followRepo = (repo: string | null): void => {
    for (const view of [branchesView, remotesView, stashView]) view.setActiveRepo(repo);
  };
  followRepo(extensionState.getLastActiveRepo());

  // Mirror the graph's context-menu visibility settings onto when-clause
  // context keys. Both are projected from the action catalogues (ADR-0010),
  // so a new key is declared there.
  const syncBranchMenuVisibility = () => {
    const cmv = config.contextMenuActionsVisibility();
    const keys = { ...branchMenuContextKeys(cmv), ...stashMenuContextKeys(cmv) };
    for (const [key, value] of Object.entries(keys)) {
      void vscode.commands.executeCommand("setContext", key, value);
    }
  };
  syncBranchMenuVisibility();

  /**
   * Build a side-view visibility toggle for the active repo. Each is bound to
   * both its Show and its Hide command — the title button swaps between the two
   * by state — flips the per-repo override (falling back to the global default
   * when unset), persists it, and re-lists the view.
   */
  const makeVisibilityToggle = (
    field: SideViewField,
    globalDefault: () => boolean,
    onToggled?: (next: boolean) => void
  ) => {
    return (): void => {
      const repo = branchesView.getActiveRepo();
      if (repo === null) return;
      const state = repoManager.getRepos()[repo];
      if (state === undefined) return;
      const next = !(state[field] ?? globalDefault());
      // Re-lists the view too, through onDidWriteRepoState. The broadcast also
      // reaches the Repository Settings drawer, which draws from it (#183).
      repoManager.updateRepoState(repo, { [field]: next });
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

  // Inline blame follows the editor: each file is blamed in the known repository
  // that contains it, whatever the graph's current repository is. Created after
  // the mirror above so a repo the built-in git just found is known by the time
  // the controller hears about it.
  const knownRepos = () => Object.keys(repoManager.getRepos());
  context.subscriptions.push(
    createBlameController({
      knownRepos,
      gitPath: config.gitPath,
      gitEnv,
      onCommand: logger.logCmd,
      onDidChangeKnownRepos: scmRepoTracker.onDidChangeRepos,
      // The same gate as the graph's avatars: off, nothing is fetched.
      avatars: {
        enabled: () => config.fetchAvatars() && extensionState.isAvatarStorageAvailable(),
        cached: (email) => avatarManager.getCachedAvatar(email),
        read: (file) => avatarManager.readCachedAvatar(file),
        fetch: (email, repo, commits) => avatarManager.fetchAvatarImage(email, repo, commits)
      }
    }),
    registerBlameToggle(),
    registerBlameCopySha(),
    registerBlameOpenLineChange({ knownRepos })
  );

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

  // A Repository Setting's default changed in VSCode's settings (#211). The
  // drawer's own toggles reload the graph themselves; this way in has nobody
  // to, so the graph is told what moved and decides — it knows which repo it
  // shows and whether that repo overrides what moved.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const changed = (Object.keys(REPO_SETTING_DEFAULT_KEYS) as RepoSettingField[]).filter(
        (field) => e.affectsConfiguration(REPO_SETTING_DEFAULT_KEYS[field])
      );
      if (changed.length === 0) return;
      // The Branches side-view resolves remote branches from the same default.
      // Its other two reach it through the `ging-git-view.branches` handler.
      if (changed.includes("showRemoteBranches")) branchesView.refresh();
      currentBridge?.post({
        command: "setRepoSettingDefaults",
        defaults: config.repoSettingDefaults(),
        showRemoteBranches: config.showRemoteBranches(),
        changed
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
      // Changes made outside the extension (a CLI checkout, another tool): the
      // backstop behind the mutation-path invalidation above.
      branchFacts.invalidate();
      if (panel.visible) {
        bridge.post({ command: "refresh" });
        branchesView.refresh();
        remotesView.refresh();
      }
    });
    bridge = webviewBridgeFactory(panel.webview, repoFileWatcher, () => {
      // Every branch mutation lands here, including the side-view's (ADR-0010).
      // Dropping the cached read is only half of it: nothing else redraws the
      // Branches view afterwards, and the file watcher stays deaf for 1500ms
      // precisely because these operations fired the events it would react to.
      branchFacts.invalidate();
      branchesView.refresh();
    });
    currentBridge = bridge;
    currentWatcher = repoFileWatcher;
    avatarManager.registerBridge(bridge.post);
    const messageHandlers = registerMessageHandlers(
      bridge,
      { ...hostPorts, watcher: repoFileWatcher },
      {
        gitClient,
        fetchService,
        extensionState,
        avatarManager,
        branchFilterStore,
        branchFacts,
        branchCleanup,
        sequenceEditor,
        onSelectRepo: (repo) => {
          followRepo(repo);
          // The webview is alive and (re)loading this repo: deliver any waiting
          // delegated messages now (the webview holds them until the load lands).
          branchActionDelegate.flushDelegated(repo);
        },
        onDelegatedRan: (seq) => branchActionDelegate.delegatedRan(seq),
        // The very command the Branches side-view's title button runs.
        showAllBranches: (repo) =>
          vscode.commands.executeCommand("ging-git-view.branches.showAll", repo),
        configurePullRequestProvider: (host) =>
          void vscode.commands.executeCommand("ging-git-view.managePullRequestProviders", host),
        openScmView: () => void vscode.commands.executeCommand("workbench.view.scm")
      }
    );
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
        currentWatcher = undefined;
        branchActionDelegate.forgetPending();
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
    followRepo(repoToOpen ?? extensionState.getLastActiveRepo());

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

  // The blame hover's "locate in the graph" (#310), for a commit in the blamed
  // file's repository — which need not be the current repository. The graph is
  // opened on it and handed the commit, over the delegate's two delivery paths
  // so a panel still loading cannot drop it. Whether a branch filter is what
  // hides the commit only the graph can tell, against the history it shows; it
  // then asks for Show All the way its filter chip does.
  context.subscriptions.push(
    registerBlameLocateCommit({
      knownRepos,
      locate: ({ repo, sha }) => branchActionDelegate.locateCommit(repo, sha)
    })
  );

  /**
   * Build the cleanup candidates and open the dialog on them.
   *
   * The empty case is answered here, natively, and that is the whole reason the
   * payload is built host-side (ADR-0017): summoning the graph panel to the
   * foreground just to say "nothing to clean up" would be a worse answer than a
   * one-line notification.
   */
  const openBranchCleanup = async (): Promise<void> => {
    const repo = branchesView.getActiveRepo();
    if (repo === null) return;
    let payload;
    try {
      // The user asked for this answer now, so bypass the coalescing window.
      payload = (await branchCleanup.build(repo, { hard: true })).payload;
    } catch (e: unknown) {
      void vscode.window.showErrorMessage(
        l10n.t("branchView.cleanup.failed") + ": " + formatGitError(e)
      );
      return;
    }
    if (payload.candidates.length === 0) {
      void vscode.window.showInformationMessage(l10n.t("branchView.cleanup.none"));
      return;
    }
    await branchActionDelegate.openCleanup(repo, payload);
  };

  /** Refresh everything that may show remote state: both side-views (remote
   *  renames/removals change remote-tracking refs) and an open graph. The
   *  fetch and remote commands, run inside `runRepoMutation`, go through
   *  `repoGitClients` rather than the webview bridge, so they miss the
   *  mutation hook that would otherwise drop the cached read — and a refresh
   *  inside the coalescing window would then be served a snapshot still
   *  listing the remote-tracking branches just removed. */
  const refreshAfterRemoteChange = (): void => {
    branchFacts.invalidate();
    remotesView.refresh();
    branchesView.refresh();
    currentBridge?.post({ command: "refresh" });
  };

  /** Run `command` on the remote a Remotes side-view menu was opened on;
   *  nothing when it was opened on anything else. */
  const onRemoteItem =
    (command: (target: RemoteTarget) => PromiseLike<void>) =>
    async (item: unknown): Promise<void> => {
      const target = remoteActionTarget(item);
      if (target !== null) await command(target);
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
      followRepo(selected[0]);
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
    vscode.commands.registerCommand("ging-git-view.branches.refresh", () =>
      // Explicitly asked for by the user, so it bypasses the coalescing window.
      branchesView.refresh({ hard: true })
    ),
    // Both halves — the empty filter and the cleared highlight — belong to the
    // view; performing them from here was #43.
    vscode.commands.registerCommand("ging-git-view.branches.showAll", (repo?: unknown) =>
      branchesView.showAll(typeof repo === "string" ? repo : undefined)
    ),
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
    // Open the cleanup dialog. Reachable from the side-view title menu, the
    // command palette, and the context menu of any branch that is itself a
    // candidate — every route lands here, and none of them cares which branch
    // was right-clicked: the dialog proposes the whole set (ADR-0017).
    vscode.commands.registerCommand("ging-git-view.branches.cleanup", () => openBranchCleanup()),
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
    vscode.commands.registerCommand("ging-git-view.remotes.add", () =>
      remoteCommands.add(remotesView.getActiveRepo())
    ),
    vscode.commands.registerCommand(
      "ging-git-view.remotes.editUrl",
      onRemoteItem(remoteCommands.editUrl)
    ),
    vscode.commands.registerCommand(
      "ging-git-view.remotes.rename",
      onRemoteItem(remoteCommands.rename)
    ),
    vscode.commands.registerCommand(
      "ging-git-view.remotes.remove",
      onRemoteItem(remoteCommands.remove)
    ),
    vscode.commands.registerCommand(
      "ging-git-view.remotes.fetchOne",
      onRemoteItem((target) => fetchService.fetchOneCommand(target.repo, target.name))
    ),
    vscode.commands.registerCommand(
      "ging-git-view.remotes.copyUrl",
      onRemoteItem((target) => vscode.env.clipboard.writeText(target.fetchUrl))
    ),
    vscode.commands.registerCommand("ging-git-view.clearAvatarCache", () => {
      avatarManager.clearCache();
    }),
    vscode.commands.registerCommand("ging-git-view.fetch", () => fetchService.fetchCommand()),
    vscode.commands.registerCommand(
      "ging-git-view.managePullRequestProviders",
      (host?: string | null) => managePullRequestProviders(host)
    ),
    // View/add/edit/delete remotes; offered as a command since neo has no
    // settings widget.
    vscode.commands.registerCommand("ging-git-view.manageRemotes", () =>
      remoteCommands.manageRemotes()
    ),
    vscode.commands.registerCommand("ging-git-view.fetchRemote", () =>
      fetchService.fetchRemoteCommand()
    ),
    // Browse the reflog (and commits dangling beyond it) and recover any of
    // them. A command + QuickPick, since neo has no settings widget.
    vscode.commands.registerCommand(
      "ging-git-view.viewReflog",
      createReflogCommand({
        prompts: vscodePrompts,
        clipboard: vscodeClipboard,
        l10n: vscodeL10n,
        gitClientFor: repoGitClients.gitClientFor,
        currentRepo,
        repoSource: repoManager,
        runRepoMutation
      }).viewReflog
    ),
    vscode.commands.registerCommand("ging-git-view.showStatistics", async () => {
      // Open a read-only stats panel (commits by author + activity heatmap).
      const stats = await infoCommands.statistics();
      if (stats !== undefined) showStatistics(stats);
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
    // Show/hide the branches of individual remotes for the current repo.
    vscode.commands.registerCommand("ging-git-view.toggleRemoteVisibility", () =>
      remoteCommands.toggleRemoteVisibility()
    ),
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
      repoManager.updateRepoState(repo, { customName: trimmed === "" ? null : trimmed });
    }),
    vscode.commands.registerCommand("ging-git-view.openExtensionSettings", () => {
      // Quick access to this extension's settings.
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:0miles.ging-git-view"
      );
    }),
    // neo has no Settings Widget; the local/global user name & email are set
    // through this command instead.
    vscode.commands.registerCommand("ging-git-view.setGitUserDetails", () =>
      infoCommands.setGitUserDetails()
    ),
    vscode.commands.registerCommand("ging-git-view.getVersionInfo", () =>
      infoCommands.versionInfo()
    ),
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
        fetchService.restartAutoFetch();
      } else if (e.affectsConfiguration("ging-git-view.branches")) {
        // Threshold / always-show / default-visibility changes re-classify the
        // side-view's inactive branches.
        branchesView.refresh();
      } else if (e.affectsConfiguration("ging-git-view.contextMenuActions")) {
        // Keep the side-views' branch and stash menus in step with the graph's.
        syncBranchMenuVisibility();
      }
    }),
    repoWatcher,
    scmRepoTracker
  );

  logger.log("Extension activated successfully");
}

export function deactivate() {}
