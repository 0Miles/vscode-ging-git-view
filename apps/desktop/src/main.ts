/* The desktop host's main process (#291): one window, themed after the system,
 * and a single instance that takes the command lines of later launches (#386).
 * The window's own page is the tab strip and, under it, the Welcome page
 * (#393). Each Tab is a view of its own laid out below the strip, showing a
 * graph on its repository through one webview instance with a dispatch of its
 * own over the services instances share (#388). */

import childProcess from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  shell,
  type WebContents,
  webContents,
  WebContentsView
} from "electron";

import { getNonce } from "@ging/core/backend/utils/nonce";
import { createRepoCloneCommand } from "@ging/core/extension/repoCloneCommand";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import { createRepoInitCommand } from "@ging/core/extension/repoInitCommand";
import type { WebviewChannel } from "@ging/core/extension/webviewBridge";
import type { ExtensionState } from "@ging/core/extensionState";
import type { HostLogger } from "@ging/core/host/ports";
import { EDITOR_ASSETS } from "@ging/desktop/editorAssets";
import { createDesktopClipboard } from "@ging/desktop/ports/clipboard";
import { createDesktopLogger } from "@ging/desktop/ports/logger";
import { type OsShell, openWebUrl } from "@ging/desktop/ports/opener";
import {
  createDesktopPrompts,
  type DesktopPrompts,
  type NativeDialogs,
  pickOne
} from "@ging/desktop/ports/prompts";
import type { RequestMessage } from "@ging/shared/types";
import type { ViewerMessage } from "@ging/webview/desktop/diff/protocol";
import {
  type HostPromptMessage,
  type HostPromptReply,
  isHostPromptReply
} from "@ging/webview/desktop/hostPrompt";
import {
  isSideViewRequest,
  type SideViewRequest,
  type SideViewMessage
} from "@ging/webview/desktop/sideViews/protocol";
import {
  isWindowRequest,
  TAB_STRIP_HEIGHT,
  type WelcomeContent,
  type WindowStateMessage
} from "@ging/webview/desktop/window/protocol";
import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";

import { type AppCommands, createAppCommands } from "./appCommands";
import { type AppMenuCommands, appMenuTemplate, menuFocus } from "./appMenu";
import { CHANNELS } from "./channels";
import { createGraphInstance, type GraphInstance, type InstanceCommands } from "./graphInstance";
import {
  type LaunchCommandLine,
  type LaunchRequest,
  type LaunchRuntime,
  parseForwardedLaunch,
  parseLaunchArgs
} from "./launchArgs";
import { buildDesktopPage, type Notice, PAGE_ASSETS, type PageContent } from "./page";
import { keepPageInPlace } from "./pageGuard";
import { createRecentRepos, type RecentRepos } from "./recentRepos";
import { createRepoCloning, type RepoCloning } from "./repoCloning";
import { createRepoOpening, type RepoOpening } from "./repoOpening";
import { type RepoToOpen, repoToOpen } from "./repoToOpen";
import { DESKTOP_SETTINGS_SCHEMA } from "./settings/schema";
import {
  buildSettingsPageState,
  createSettingsPageHandler,
  schemaLocale
} from "./settings/settingsPage";
import { createSettingsWindow, type SettingsWindow } from "./settingsWindow";
import { createSharedServices, desktopGitPath, type SharedServices } from "./sharedServices";
import { createStatisticsWindow, type StatisticsWindow } from "./statisticsWindow";
import {
  createTabWindow,
  layoutTabViews,
  type TabPageLike,
  tabStripEntries,
  type TabWindow
} from "./tabWindow";
import { launchTerminal, terminalLaunches } from "./terminal";
import { type Theme, themeFor } from "./theme";
import { readThemeChoice, writeThemeChoice } from "./themeChoice";

/**
 * The page and its files are served from `ging://app/`, not `file://`: a
 * standard, secure scheme gives the page a real origin of its own — the
 * webview's storage needs one, and its content security policy can say 'self'
 * — while the main process decides exactly which files are reachable
 * (ADR-0031's 補記 of 2026-11-13).
 */
const SCHEME = "ging";
const HOST = "app";
const PAGE_URL = `${SCHEME}://${HOST}/`;
/** The settings page's path (#397), in a window of its own. */
const SETTINGS_PATH = "/settings";
/** The Statistics page's path (#396), in a window of its own. */
const STATISTICS_PATH = "/statistics";
/** A Tab's page's path, the Tab's id in `TAB_ID_PARAM` (#393). */
const TAB_PATH = "/tab";
const TAB_ID_PARAM = "id";
/** The files in out/, next to this bundle, that `ging://app/<file>` serves:
 *  the page's assets and its script's source map, and the editor's that a
 *  page loads for its diff viewer (#404; built without source maps). Nothing
 *  else is served. */
const SERVED_FILES = new Set<string>([
  ...Object.values(PAGE_ASSETS),
  `${PAGE_ASSETS.script}.map`,
  ...Object.values(EDITOR_ASSETS)
]);

/** Every page's: the preload, and nothing of Node's in the page. */
const WEB_PREFERENCES = {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false
};

function currentTheme(): Theme {
  return themeFor(nativeTheme.shouldUseDarkColors ? "dark" : "light", process.platform);
}

/** What a Tab's view shows: a graph, or a notice in its place. Its page is
 *  built anew at each load of the view. */
type TabPage = TabPageLike & {
  page: () => PageContent;
  /** The webview instance answering it, when it is a graph. */
  instance: GraphInstance | null;
  /** The instance's prompts, asked in its page. */
  prompts: DesktopPrompts | null;
  /** Hand the instance a message its page posted. */
  deliver: (message: RequestMessage | HostPromptReply | SideViewRequest) => void;
  /** A prompt of its is waiting for an answer. */
  asking: boolean;
};

/** Report what a launch asked for, and what it asked to open, if anything. */
function logLaunch(request: LaunchRequest, logger: HostLogger): void {
  if (request.ignored.length > 0) {
    logger.log(`launch: ignored arguments ${JSON.stringify(request.ignored)}`);
  }
  if (request.repo !== null) logger.log(`launch: repository ${request.repo}`);
}

/** Electron's dialogs attached to `owner`, looked up when called so the E2E
 *  can answer in their place (ADR-0032). */
function dialogsFor(owner: BrowserWindow): NativeDialogs {
  return {
    showMessageBox: (options) => dialog.showMessageBox(owner, options),
    showSaveDialog: (options) => dialog.showSaveDialog(owner, options),
    showOpenDialog: (options) => dialog.showOpenDialog(owner, options)
  };
}

/** What the system opens things with, each looked up when called — Electron's
 *  `shell` and Node's `spawn` — so the E2E can stand in for them and start no
 *  program, browser or terminal (ADR-0032). */
const systemOs: OsShell = {
  openPath: (file) => shell.openPath(file),
  showItemInFolder: (file) => shell.showItemInFolder(file),
  openExternal: (url) => shell.openExternal(url),
  openTerminal: (cwd, title) =>
    launchTerminal(
      (command, args, options) => childProcess.spawn(command, args, options),
      terminalLaunches(process.platform, process.env, cwd, title)
    )
};

/** Serve the app: `pageFor` builds the page a URL of it asks for — a page of
 *  the desktop entry, or a whole document of its own — or answers null for a
 *  URL that is no page. */
function serveApp(pageFor: (url: URL) => PageContent | { document: string } | null): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response(null, { status: 404 });
    const content = pageFor(url);
    if (content !== null) {
      const html =
        "document" in content ? content.document : buildDesktopPage(currentTheme(), content);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const file = url.pathname.slice(1);
    if (!SERVED_FILES.has(file)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, file)).href);
  });
}

function createWindow(): BrowserWindow {
  const theme = currentTheme();
  return new BrowserWindow({
    width: 1200,
    height: 800,
    // Painted before the page is, so the window does not flash the wrong colour.
    backgroundColor: theme.background,
    webPreferences: WEB_PREFERENCES
  });
}

/** Every page follows the app's theme as it changes: the system's, or the one
 *  the user chose (`nativeTheme.themeSource`, #397) — each window's, and each
 *  Tab's in its view, which `repaint` paints. */
function followSystemTheme(repaint: (theme: Theme) => void): void {
  nativeTheme.on("updated", () => {
    const theme = currentTheme();
    for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(theme.background);
    repaint(theme);
    // Every page there is: the windows' own and the Tabs' views'.
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send(CHANNELS.theme, theme);
    }
  });
}

/** Hand the page in `contents` a host message; false when it is gone. */
function sendTo(contents: WebContents) {
  return (message: unknown): boolean => {
    if (contents.isDestroyed()) return false;
    contents.send(CHANNELS.hostMessage, message);
    return true;
  };
}

/** The page in `contents`, as a webview instance talks to it; `deliver` hands
 *  it what the page posted, and `post` shows it one of the instance's prompts,
 *  its side views' state (#399), or one of its diffs (#404) or files (#405),
 *  on the same channel as the graph's messages (ADR-0031). */
function channelTo(contents: WebContents, logger: HostLogger) {
  let listener: ((message: RequestMessage) => void | Promise<void>) | null = null;
  const send = sendTo(contents);
  const channel: WebviewChannel = {
    onDidReceiveMessage: (l) => {
      listener = l;
    },
    postMessage: (message) => Promise.resolve(send(message))
  };
  const post: (message: HostPromptMessage | SideViewMessage | ViewerMessage) => boolean = send;
  const deliver = (message: RequestMessage) => {
    // A handler that throws has no one else to tell: the dispatch answers what
    // it catches, and this is what it did not.
    Promise.resolve(listener?.(message)).catch((e: unknown) =>
      logger.logError(`webview: handling "${message.command}" failed: ${String(e)}`)
    );
  };
  return { channel, deliver, post };
}

/** What a path that opens no repository shows: on the Welcome page, or in a
 *  Tab in place of its graph. */
function cannotOpenNotice({ l10n }: Pick<SharedServices, "l10n">, repo: string): Notice {
  return {
    title: l10n.t("error.unableToLoadGitGraph"),
    detail: l10n.t("desktop.cannotOpenRepo", repo)
  };
}

const thisLaunch: LaunchCommandLine = { argv: process.argv, workingDirectory: process.cwd() };
const runtime: LaunchRuntime = { defaultApp: process.defaultApp === true };

if (app.requestSingleInstanceLock(thisLaunch)) {
  // Only the process holding the lock writes the log: the lock's scope is the
  // user data folder the log is in (ADR-0032), so the file is this process's.
  const logger = createDesktopLogger({
    file: path.join(app.getPath("userData"), "logs", "main.log"),
    open: (file) => shell.openPath(file)
  });

  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true } }
  ]);

  let shared: SharedServices | null = null;
  let win: BrowserWindow | null = null;
  let settingsWindow: SettingsWindow | null = null;
  let statisticsWindow: StatisticsWindow | null = null;
  /** The window's Tabs (tabWindow.ts), once the window is there. */
  let tabWindow: TabWindow<WebContentsView, TabPage> | null = null;
  /** Why the Welcome page shows no repository: a launch named a path that is
   *  none. Said only while no Tab is open, and forgotten once one is. */
  let welcomeNotice: Notice | null = null;
  /** The window's page has said it listens, since it last started loading. */
  let windowListening = false;
  /** Asked on the Welcome page, when there is no Tab to ask in: #394's and
   *  #396's commands ask here. */
  let welcomePrompts: DesktopPrompts | null = null;
  /** The menu's commands that need no graph, as the Welcome page runs them. */
  let welcomeCommands: AppCommands | null = null;
  /** The Tab whose view last had the keyboard handed to it. */
  let keyboardTab: number | null = null;
  /** The recently opened list, in the order it was opened in (#394). */
  let recent: RecentRepos | null = null;
  /** Open Folder, Initialize Repository and the recent list's entries (#394),
   *  once the window is there to ask in. */
  let repoOpening: RepoOpening | null = null;
  /** Clone Repository (#395), asked and shown on the Welcome page. */
  let repoCloning: RepoCloning | null = null;
  /** Settles once a clone cancelled as the window went has ended. */
  let cloneEnded: Promise<void> = Promise.resolve();

  const tabList = () => tabWindow?.tabs.list() ?? [];
  const focusedTab = () => tabWindow?.tabs.focused() ?? null;
  /** The Tab whose view's page is `contents`. */
  const tabOf = (contents: WebContents) =>
    tabList().find((tab) => tab.content.view.webContents === contents) ?? null;
  /** The webview instance of the focused Tab: the menu's commands run there. */
  const focusedInstance = () => focusedTab()?.content.page.instance ?? null;
  /** The window, while it is there to draw in. */
  const liveWindow = () => (win !== null && !win.isDestroyed() ? win : null);

  /** The application menu's commands. Each looks up where it runs when it is
   *  clicked, not when the menu was built, and never from the window a click
   *  hands it — `MenuItem.click()` hands none (#396). The app has one window
   *  with Tabs (#393), so whichever window has the keyboard — a settings or
   *  statistics window included — the target is that window's focused Tab, or
   *  with no Tab its Welcome page. The template enables only what has a
   *  target; one that is gone by the click does nothing. */
  const menuCommands: AppMenuCommands = (() => {
    /** `run` on the focused Tab's instance, if there is one. */
    const onGraph =
      (run: (commands: InstanceCommands) => unknown): (() => void) =>
      () => {
        const commands = focusedInstance()?.commands;
        if (commands) void run(commands);
      };
    /** `run` where it can ask: the focused Tab's instance, or — with no Tab —
     *  the Welcome page. A Tab with a notice has neither. */
    const asking =
      (run: (commands: AppCommands) => unknown): (() => void) =>
      () => {
        const focused = focusedTab();
        const commands =
          focused === null ? welcomeCommands : focused.content.page.instance?.commands;
        if (commands) void run(commands);
      };
    /** `run`, unless a clone is asked for or running (#395). */
    const unlessCloning =
      (run: () => void): (() => void) =>
      () => {
        if (!repoCloning?.busy()) run();
      };
    return {
      openSettings: () => settingsWindow?.open(),
      fetch: onGraph((c) => c.fetch()),
      fetchRemote: onGraph((c) => c.fetchRemote()),
      manageRemotes: onGraph((c) => c.manageRemotes()),
      toggleRemoteVisibility: onGraph((c) => c.toggleRemoteVisibility()),
      viewReflog: onGraph((c) => c.viewReflog()),
      showStatistics: () => {
        const tab = focusedTab();
        const commands = tab?.content.page.instance?.commands;
        if (!tab || !commands) return;
        void commands.statistics().then((figures) => {
          if (figures !== undefined) statisticsWindow?.show(figures, tab.repo);
        });
      },
      openTerminal: onGraph((c) => c.openTerminal()),
      fileHistory: onGraph((c) => c.fileHistory()),
      blameFile: onGraph((c) => c.blameFile()),
      setGitUserDetails: asking((c) => c.setGitUserDetails()),
      managePullRequestProviders: asking((c) => c.managePullRequestProviders()),
      // In a system dialog, so it needs no page: the Welcome page's will do
      // behind a notice too.
      hideApp: () => app.hide(),
      versionInfo: () => {
        const commands = focusedInstance()?.commands ?? welcomeCommands;
        void commands?.versionInfo();
      },
      // #394's: the folder is asked in the system's own dialog, so these need
      // no page, Tab or no Tab.
      // Not while a clone is under way (the template disables them): a Tab
      // would cover its progress and the credentials it may ask for.
      openFolder: unlessCloning(() => void repoOpening?.openFolder()),
      openRecent: (repo) => {
        if (!repoCloning?.busy()) {
          void repoOpening?.openRecent(repo).finally(checkRecentWhileShown);
        }
      },
      initRepository: unlessCloning(() => void repoOpening?.initRepo()),
      // Asked and shown on the Welcome page, brought forward over the Tabs
      // for it (#461).
      cloneRepository: () => void cloneRepo()
    };
  })();

  /** The application menu, built anew for what the window shows now: which
   *  entries are enabled is the template's to say (appMenu.ts). Not before the
   *  shared services, whose language it speaks. */
  /** Whether the menu as last built took a clone to be busy. */
  let menuShowsCloning = false;
  const syncMenu = () => {
    if (shared === null) return;
    menuShowsCloning = repoCloning?.busy() ?? false;
    const template = appMenuTemplate(shared.l10n, menuCommands, process.platform, {
      focus: menuFocus(focusedTab()?.content.page ?? null),
      // Open Recent's entries: the Welcome page's list, as it stands.
      recentRepos: recent?.list().map((entry) => entry.path) ?? [],
      cloning: menuShowsCloning
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  /** What the Welcome page offers (#394): its entries and the recent list. */
  const welcomeContent = (): WelcomeContent | null => {
    if (shared === null || recent === null) return null;
    const { l10n } = shared;
    return {
      recent: recent.list(),
      strings: {
        // The menu's words: the same entries (#396).
        openFolder: l10n.t("desktop.menu.openFolder"),
        cloneRepo: l10n.t("desktop.menu.cloneRepository"),
        initRepo: l10n.t("desktop.menu.initRepository"),
        recent: l10n.t("desktop.welcome.recent"),
        noRecent: l10n.t("desktop.welcome.noRecent"),
        missing: l10n.t("desktop.welcome.missing"),
        forget: l10n.t("desktop.welcome.forget")
      }
    };
  };

  /** Tell the window's page the Tabs and what the Welcome page says, once it
   *  listens and for as long as it is there. A Tab is marked as asking only
   *  behind another: the one in front shows its prompt itself. */
  const postWindowState = () => {
    const owner = liveWindow();
    if (!windowListening || owner === null || owner.webContents.isDestroyed()) return;
    if (shared === null) return;
    const repos = shared.repoSource.getRepos();
    // No Tab, or none in front of it (#461).
    const welcomeShown = focusedTab() === null;
    const message: WindowStateMessage = {
      command: "windowState",
      tabs:
        tabWindow === null
          ? []
          : tabStripEntries(
              tabWindow.tabs,
              (tab) => repos[tab.repo]?.customName || path.basename(tab.repo),
              (tab) => tab.content.page.asking
            ),
      notice: welcomeShown ? welcomeNotice : null,
      // Only while it shows. What it says of each folder is what was last
      // found (`RecentRepos.check`), never looked at here.
      welcome: welcomeShown ? welcomeContent() : null,
      // Drawn on the Welcome page, and as an entry of the strip's that brings
      // it forward again while a Tab is in front (#461).
      clone: repoCloning?.panel() ?? null,
      strings: { closeTab: shared.l10n.t("desktop.tab.close") }
    };
    owner.webContents.send(CHANNELS.hostMessage, message);
  };

  /** Put the Tabs' views where `layoutTabViews` says, and the keyboard in the
   *  focused one when it has just come forward. */
  const layoutTabs = () => {
    const owner = liveWindow();
    if (owner === null) return;
    const [width, height] = owner.getContentSize();
    const focused = focusedTab();
    const shown = owner.contentView.children;
    for (const { tab, bounds, inWindow } of layoutTabViews(
      tabList(),
      focused,
      [width, height],
      TAB_STRIP_HEIGHT
    )) {
      const { view } = tab.content;
      view.setBounds(bounds);
      if (!inWindow && shown.includes(view)) owner.contentView.removeChildView(view);
      if (inWindow && !shown.includes(view)) owner.contentView.addChildView(view);
    }
    // The keyboard goes where the user's eyes do: to the Tab brought forward,
    // or to the Welcome page brought forward over the Tabs (#461).
    if (focused !== null && focused.id !== keyboardTab) focused.content.view.webContents.focus();
    if (focused === null && keyboardTab !== null) owner.webContents.focus();
    keyboardTab = focused?.id ?? null;
  };

  /** What the window shows after the Tabs changed. */
  const tabsChanged = () => {
    layoutTabs();
    postWindowState();
    syncMenu();
    checkRecentWhileShown();
  };

  /** Look at the recent list's folders again, while the Welcome page shows
   *  it: what is found comes back through `postWindowState`. */
  const checkRecentWhileShown = () => {
    if (focusedTab() === null) recent?.check();
  };

  /** Clone Repository (#395) whatever is in front (#461): the Welcome page,
   *  where it is asked and shown, comes forward over the Tabs. A clone that
   *  opened nothing — cancelled, failed, or never asked for — goes back to
   *  the Tab that was in front, unless one has been brought forward since. */
  const cloneRepo = async () => {
    if (repoCloning === null || repoCloning.busy()) return;
    tabWindow?.tabs.focusWelcome();
    try {
      await repoCloning.clone();
    } finally {
      tabWindow?.tabs.restoreFocus();
    }
  };

  /** What `request` names, checked: a repository, a path that is none, or
   *  `null` when it names nothing. */
  const check = (request: LaunchRequest): Promise<RepoToOpen | null> =>
    request.repo === null ? Promise.resolve(null) : repoToOpen(request.repo, desktopGitPath());

  /** Open what a launch named: its repository in a Tab (#393), or a notice
   *  that it is none. The notice is the Welcome page's only while no Tab is
   *  open: a later launch naming a bad path must not take the place of a
   *  graph someone is using, so there it is said in a box over it. */
  const open = (target: RepoToOpen | null) => {
    const owner = liveWindow();
    if (shared === null || owner === null || tabWindow === null || target === null) return;
    const host = shared;
    if ("unusable" in target) {
      logger.log(`launch: cannot open ${target.unusable}, not a Git repository`);
      const notice = cannotOpenNotice(host, target.unusable);
      if (tabList().length === 0) {
        welcomeNotice = notice;
        postWindowState();
      } else {
        void dialogsFor(owner).showMessageBox({
          type: "error",
          message: notice.title,
          detail: notice.detail
        });
      }
      return;
    }
    logger.log(`launch: opening ${tabWindow.resolve(target.repo)}`);
    openInTab(target.repo);
  };

  /** What later launches named while a clone was asked for or running
   *  (#395), in the order they came: opened once it is done. */
  let launchesWaiting: (RepoToOpen | null)[] = [];
  /** `open` what a later launch named — unless a clone is under way: its
   *  prompts and progress are on the Welcome page, which a Tab would cover,
   *  leaving git waiting on a credential nobody can see. */
  const openOrWait = (target: RepoToOpen | null) => {
    if (target === null) return;
    if (repoCloning?.busy()) {
      logger.log("launch: a clone is under way, opening what was named once it is done");
      launchesWaiting.push(target);
      return;
    }
    open(target);
  };
  /** The clone is done: open what launches named meanwhile. */
  const openWaitingLaunches = () => {
    const waiting = launchesWaiting;
    launchesWaiting = [];
    waiting.forEach(open);
  };

  /** Open `repo`, a repository as git spells it, in a Tab of its own — or
   *  focus the Tab it is open in — and put it first in the recent list. Named
   *  on a command line or chosen in the app alike (GLOSSARY.md's Known
   *  repository). */
  const openInTab = (repo: string) => {
    if (tabWindow === null) return;
    const known = tabWindow.resolve(repo);
    welcomeNotice = null;
    tabWindow.openRepo(known);
    recent?.opened(known);
    // Open Recent's order changed after the Tabs' did, which rebuilt the menu.
    syncMenu();
  };

  /** Take `repo` off the recent list — unless a Tab has it open: the Tab's
   *  graph is shown its repository from the known set (graphInstance.ts). */
  const forgetRecent = (repo: string) => {
    if (tabWindow !== null && tabWindow.tabs.find(repo) !== null) {
      logger.log(`recent: ${repo} is open in a Tab, kept on the list`);
      return;
    }
    logger.log(`recent: forgetting ${repo}`);
    recent?.forget(repo);
  };

  /** What the window's own page posted: the strip's requests, and the replies
   *  to the Welcome page's prompts. */
  const fromWindowPage = (message: unknown) => {
    if (isHostPromptReply(message)) {
      welcomePrompts?.receive(message);
      return;
    }
    if (!isWindowRequest(message)) {
      logger.log(`window: "${String((message as { command?: unknown })?.command)}" is not its`);
      return;
    }
    switch (message.command) {
      case "windowReady":
        windowListening = true;
        postWindowState();
        checkRecentWhileShown();
        break;
      case "focusTab":
        tabWindow?.tabs.focus(message.id);
        break;
      case "closeTab":
        tabWindow?.tabs.close(message.id);
        break;
      case "openFolder":
        void repoOpening?.openFolder();
        break;
      case "initRepo":
        void repoOpening?.initRepo();
        break;
      case "cloneRepo":
        void cloneRepo();
        break;
      case "showClone":
        // The strip's entry for the clone running (#461).
        if (repoCloning?.panel()) tabWindow?.tabs.focusWelcome();
        break;
      case "cancelClone":
        repoCloning?.cancel();
        break;
      case "openRecent":
        // Whether it opened or not, the list looks at its folders again.
        void repoOpening?.openRecent(message.path).finally(checkRecentWhileShown);
        break;
      case "forgetRecent":
        forgetRecent(message.path);
        break;
    }
  };

  /** The window is going, or the app: every Tab is done with, without a word
   *  to the window's page, which is going too. Not closed one by one: the
   *  Tabs as they stand are what the next session opens. */
  const disposeWindow = () => {
    windowListening = false;
    win = null;
    tabWindow?.tabs.disposeAll();
    // Its git is sent a kill, and what it made removed: quitting waits for it.
    cloneEnded = repoCloning?.dispose() ?? cloneEnded;
    welcomePrompts?.dispose();
    recent?.dispose();
  };

  const launch = parseLaunchArgs(thisLaunch, runtime);
  logLaunch(launch, logger);
  // Asked of git while Electron gets ready, not after.
  const launchTarget = check(launch);
  // The later launch's own command line, not the `argv` beside it: see LaunchCommandLine.
  app.on("second-instance", (_event, _argv, _workingDirectory, data) => {
    const request = parseForwardedLaunch(data, runtime);
    if (request === null) {
      logger.log("launch: a later launch forwarded nothing readable");
    } else {
      logLaunch(request, logger);
      // In a Tab of its own, or the one it is open in, brought forward.
      void check(request).then(openOrWait);
    }
    const owner = liveWindow();
    if (owner !== null) {
      if (owner.isMinimized()) owner.restore();
      owner.focus();
    }
  });
  ipcMain.on(
    CHANNELS.webviewMessage,
    (event, message: RequestMessage | HostPromptReply | SideViewRequest) => {
      // The settings window's page talks to the settings, never to an instance.
      if (settingsWindow?.deliver(event.sender, message)) return;
      if (win !== null && event.sender === win.webContents) {
        fromWindowPage(message);
        return;
      }
      tabOf(event.sender)?.content.page.deliver(message);
    }
  );

  app.on("window-all-closed", () => app.quit());
  // The log and the state file are written out before the process goes, and
  // a clone cancelled has removed what it made (#395): quitting waits once for
  // all three, then goes on.
  let logClosed = false;
  app.on("will-quit", (event) => {
    if (logClosed) return;
    event.preventDefault();
    disposeWindow();
    void cloneEnded
      .then(async () => {
        // After the clone: its askpass route is the shared server's.
        shared?.dispose();
        // The Tabs as they stand, the recent list's order: the next session's.
        await shared?.storage.flush();
        return logger.close();
      })
      .finally(() => {
        logClosed = true;
        app.quit();
      });
  });
  void app.whenReady().then(async () => {
    // After ready: the locale is not known before it. Before the window, whose
    // first paint is in the theme the user left the app in.
    const host = createSharedServices({
      userDataPath: app.getPath("userData"),
      locale: app.getLocale(),
      helperDir: __dirname,
      logger,
      clipboard: createDesktopClipboard(clipboard),
      os: systemOs,
      hostVersions: [
        { name: "GING", version: app.getVersion() },
        { name: "Electron", version: process.versions.electron },
        { name: "Chromium", version: process.versions.chrome }
      ]
    });
    shared = host;
    /** Where every link out of a page of the app goes: the browser, when it is
     *  a web address (`openWebUrl`), and nowhere else (#391). */
    const linksOut = { openExternalUrl: (url: string) => openWebUrl(host.os, logger, url) };
    nativeTheme.themeSource = readThemeChoice(host.storage.global);

    const handleSettings = createSettingsPageHandler({
      config: host.config,
      settings: host.settings,
      l10n: host.l10n,
      logger,
      instances: () =>
        tabList().flatMap((tab) => (tab.content.page.instance ? [tab.content.page.instance] : [])),
      setTheme: (choice) => {
        nativeTheme.themeSource = choice;
        void writeThemeChoice(host.storage.global, choice);
      }
    });
    settingsWindow = createSettingsWindow({
      url: `${PAGE_URL}${SETTINGS_PATH.slice(1)}`,
      createWindow,
      handle: handleSettings,
      opener: linksOut,
      logger,
      // Only ever a key the app has: the one Show Setting names.
      valueOf: (key) => host.settings.get(key)
    });
    statisticsWindow = createStatisticsWindow({
      url: `${PAGE_URL}${STATISTICS_PATH.slice(1)}`,
      lang: app.getLocale(),
      createWindow,
      l10n: host.l10n,
      opener: linksOut
    });
    // Its Settings… entry (CmdOrCtrl+,) opens the window above.
    syncMenu();
    const settingsPage = (): PageContent => ({
      settings: {
        state: buildSettingsPageState({
          schema: DESKTOP_SETTINGS_SCHEMA,
          settings: host.settings,
          locale: schemaLocale(app.getLocale()),
          l10n: host.l10n,
          theme: readThemeChoice(host.storage.global)
        }),
        nonce: getNonce()
      }
    });

    serveApp((url) => {
      if (url.pathname === "/") return { window: true };
      if (url.pathname === SETTINGS_PATH) return settingsPage();
      if (url.pathname === STATISTICS_PATH) {
        const document = statisticsWindow?.document(currentTheme()) ?? null;
        return document === null ? null : { document };
      }
      if (url.pathname === TAB_PATH) {
        const id = Number(url.searchParams.get(TAB_ID_PARAM));
        return (
          tabList()
            .find((tab) => tab.id === id)
            ?.content.page.page() ?? { notice: null }
        );
      }
      return null;
    });
    followSystemTheme((theme) => {
      for (const tab of tabList()) tab.content.view.setBackgroundColor(theme.background);
    });
    // A Tab's title is its repository's custom name, when it has one; and the
    // recent list is the known set (#394).
    host.repoSource.onDidChangeRepos(() => {
      postWindowState();
      syncMenu();
      checkRecentWhileShown();
    });

    const owner = createWindow();
    // The window's own page — the Tab strip, the Welcome page — stays put as
    // every page of the app does.
    keepPageInPlace(owner.webContents, linksOut);
    win = owner;
    const welcomeAsker = createDesktopPrompts({
      dialogs: dialogsFor(owner),
      l10n: host.l10n,
      logger,
      page: { post: sendTo(owner.webContents) }
    });
    welcomePrompts = welcomeAsker;
    const welcomeGitClients = createRepoGitClients({ gitPath: host.gitPath });
    welcomeCommands = createAppCommands(host, {
      prompts: welcomeAsker,
      // No repository: Set Git User Details offers every repository alone.
      currentRepo: () => null,
      gitClientFor: welcomeGitClients.gitClientFor,
      revealSetting: (key) => settingsWindow?.reveal(key)
    });

    /** A graph on `repo` in `view`, its Current repository kept in `state`. */
    const graphPage = (view: WebContentsView, repo: string, state: ExtensionState): TabPage => {
      const { channel, deliver, post } = channelTo(view.webContents, logger);
      // Asked in this Tab's page: a prompt git raises for it comes back here
      // through its askpass route, whichever Tab is in front (#393).
      const prompts = createDesktopPrompts({
        dialogs: dialogsFor(owner),
        l10n: host.l10n,
        logger,
        page: { post },
        onAsking: (asking) => {
          page.asking = asking;
          postWindowState();
        }
      });
      const instance = createGraphInstance(host, {
        repo,
        channel,
        prompts,
        postSideView: post,
        extensionState: state,
        revealSetting: (key) => settingsWindow?.reveal(key),
        postDiff: post,
        // The application menu's File History… (#408) and Blame File…
        // (#409): a file of the Tab's repository, in the system's dialog
        // (`NativeDialogs`, ADR-0032).
        pickFile: async (root, purpose) => {
          const [title, buttonLabel] =
            purpose === "blame"
              ? [host.l10n.t("desktop.blame.pickTitle"), host.l10n.t("desktop.blame.pickButton")]
              : [
                  host.l10n.t("desktop.fileHistory.pickTitle"),
                  host.l10n.t("desktop.fileHistory.pickButton")
                ];
          return pickOne(dialogsFor(owner), {
            title,
            buttonLabel,
            // The system's spelling of the folder, not the repository's `/` one.
            defaultPath: path.normalize(root),
            properties: ["openFile"]
          });
        }
      });
      const strings = getWebviewLocalizedStrings((key) => host.l10n.t(key));
      const page: TabPage = {
        graph: true,
        page: () => ({
          graph: { viewState: instance.pageViewState(), l10n: strings, nonce: getNonce() }
        }),
        instance,
        prompts,
        // The page's replies to the prompts, and its side views' requests
        // (#399), are not the graph's requests: the dispatch never sees them
        // (ADR-0031).
        deliver: (message) => {
          if (isHostPromptReply(message)) prompts.receive(message);
          else if (isSideViewRequest(message)) {
            // As `deliver` does for the graph's: what throws has no one else
            // to tell.
            instance
              .sideView(message)
              .catch((e: unknown) =>
                logger.logError(`side views: handling "${message.command}" failed: ${String(e)}`)
              );
          } else deliver(message);
        },
        asking: false,
        dispose: () => {
          try {
            instance.dispose();
          } finally {
            prompts.dispose();
          }
        }
      };
      return page;
    };

    tabWindow = createTabWindow<WebContentsView, TabPage>({
      tabStates: host.tabStates,
      repoSource: host.repoSource,
      logger,
      makeView: () => {
        const view = new WebContentsView({ webPreferences: WEB_PREFERENCES });
        view.setBackgroundColor(currentTheme().background);
        keepPageInPlace(view.webContents, linksOut);
        // The page starting to load, the first time or again (a reload): the
        // graph it brings has yet to pick its repository. Tied to the load,
        // not to building the HTML, which a second fetch of it would repeat.
        view.webContents.on("did-start-navigation", (details) => {
          if (!details.isMainFrame || details.isSameDocument) return;
          const loading = tabOf(view.webContents)?.content.page;
          loading?.instance?.pageLoading();
          loading?.prompts?.pageLoading();
        });
        return view;
      },
      graphPage,
      // In place of a graph, why there is none. Nothing on it should post
      // anything; whatever does is said in the log.
      noticePage: (persisted) => {
        const notice = cannotOpenNotice(host, persisted);
        return {
          graph: false,
          page: () => ({ notice }),
          instance: null,
          prompts: null,
          deliver: (message) =>
            logger.log(`webview: "${String(message?.command)}" reached a page with no graph`),
          asking: false,
          dispose: () => {}
        };
      },
      load: (view, id) =>
        void view.webContents.loadURL(`${PAGE_URL}${TAB_PATH.slice(1)}?${TAB_ID_PARAM}=${id}`),
      disposeView: (view) => {
        const window = liveWindow();
        if (window !== null && window.contentView.children.includes(view)) {
          window.contentView.removeChildView(view);
        }
        if (!view.webContents.isDestroyed()) view.webContents.close();
      },
      onChange: tabsChanged
    });

    recent = createRecentRepos({
      store: host.storage.workspace,
      repoSource: host.repoSource,
      // A folder found otherwise than the list said: the Welcome page says so.
      onChange: postWindowState
    });
    // Asked in the window it opens in; a failed `git init` is said in a box
    // over it (`Prompts.showError` is a system dialog either way).
    const repoInit = createRepoInitCommand({
      prompts: welcomeAsker,
      l10n: host.l10n,
      gitClientFor: welcomeGitClients.gitClientFor
    });
    repoOpening = createRepoOpening({
      dialogs: dialogsFor(owner),
      l10n: host.l10n,
      logger,
      check: (folder) => repoToOpen(folder, desktopGitPath()),
      initRepo: (folder) => repoInit.initRepo(folder),
      openRepo: openInTab,
      resolve: (repo) => tabWindow?.resolve(repo) ?? repo
    });
    repoCloning = createRepoCloning({
      prompts: welcomeAsker,
      dialogs: dialogsFor(owner),
      l10n: host.l10n,
      logger,
      // A failed clone is said in a box over the window, as a failed init is.
      command: createRepoCloneCommand({
        prompts: welcomeAsker,
        l10n: host.l10n,
        gitPath: desktopGitPath
      }),
      // The credentials its git asks for are asked on the Welcome page,
      // brought forward for them should a Tab be in front (#461).
      askpassRoute: () =>
        host.askpass.route({
          input: (options) => {
            tabWindow?.tabs.focusWelcome();
            return welcomeAsker.input(options);
          }
        }),
      openRepo: openInTab,
      onChange: () => {
        postWindowState();
        // The menu shows only whether a clone is busy, not its progress: built
        // anew when that flips, not on each progress line.
        if ((repoCloning?.busy() ?? false) !== menuShowsCloning) syncMenu();
        if (!repoCloning?.busy()) openWaitingLaunches();
      }
    });

    // The window's page starting to load, the first time or again (a reload):
    // until it says it listens, nothing is sent into it.
    owner.webContents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      windowListening = false;
      welcomePrompts?.pageLoading();
    });
    // The Tabs' views take the window's size: they are not the window's page,
    // which the window sizes itself.
    owner.on("resize", layoutTabs);
    owner.on("maximize", layoutTabs);
    owner.on("unmaximize", layoutTabs);
    owner.on("closed", disposeWindow);
    void owner.loadURL(PAGE_URL);
    tabWindow.restore();
    open(await launchTarget);
  });
} else {
  // Another GING holds the lock and has been handed `thisLaunch`.
  app.quit();
}
