/* The desktop host's main process (#291): one window, themed after the system,
 * and a single instance that takes the command lines of later launches (#386).
 * The window's own page is the tab strip and, under it, the Welcome page
 * (#393). Each Tab is a view of its own laid out below the strip, showing a
 * graph on its repository through one webview instance with a dispatch of its
 * own over the services instances share (#388). */

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
import { resolveToKnownRepo } from "@ging/core/backend/utils/repoMatch";
import type { WebviewChannel } from "@ging/core/extension/webviewBridge";
import type { ExtensionState } from "@ging/core/extensionState";
import type { HostLogger } from "@ging/core/host/ports";
import { createDesktopClipboard } from "@ging/desktop/ports/clipboard";
import { createDesktopLogger } from "@ging/desktop/ports/logger";
import {
  createDesktopPrompts,
  type DesktopPrompts,
  type NativeDialogs
} from "@ging/desktop/ports/prompts";
import type { RequestMessage } from "@ging/shared/types";
import {
  type HostPromptMessage,
  type HostPromptReply,
  isHostPromptReply
} from "@ging/webview/desktop/hostPrompt";
import {
  isWindowRequest,
  TAB_STRIP_HEIGHT,
  type WindowStateMessage
} from "@ging/webview/desktop/window/protocol";
import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";

import { appMenuTemplate } from "./appMenu";
import { CHANNELS } from "./channels";
import { createGraphInstance, type GraphInstance } from "./graphInstance";
import {
  type LaunchCommandLine,
  type LaunchRequest,
  type LaunchRuntime,
  parseForwardedLaunch,
  parseLaunchArgs
} from "./launchArgs";
import { buildDesktopPage, type Notice, PAGE_ASSETS, type PageContent } from "./page";
import { type RepoToOpen, repoToOpen } from "./repoToOpen";
import { DESKTOP_SETTINGS_SCHEMA } from "./settings/schema";
import {
  buildSettingsPageState,
  createSettingsPageHandler,
  schemaLocale
} from "./settings/settingsPage";
import { createSettingsWindow, type SettingsWindow } from "./settingsWindow";
import { createSharedServices, desktopGitPath, type SharedServices } from "./sharedServices";
import { createTabs, type Tab } from "./tabs";
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
/** A Tab's page's path, the Tab's id in `TAB_ID_PARAM` (#393). */
const TAB_PATH = "/tab";
const TAB_ID_PARAM = "id";
/** The files in out/, next to this bundle, that `ging://app/<file>` serves:
 *  the page's assets and the script's source map. Nothing else is served. */
const SERVED_FILES = new Set<string>([...Object.values(PAGE_ASSETS), `${PAGE_ASSETS.script}.map`]);

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

/** What a Tab's view shows: a graph, or a notice in its place. Built anew at
 *  each load of the view's page. */
type TabPage = {
  page: () => PageContent;
  /** The webview instance answering it, when it is a graph. */
  instance: GraphInstance | null;
  /** The instance's prompts, asked in its page. */
  prompts: DesktopPrompts | null;
  /** Hand the instance a message its page posted. */
  deliver: (message: RequestMessage | HostPromptReply) => void;
  /** A prompt of its is waiting for an answer: the tab strip marks it. */
  asking: boolean;
};

/** What a Tab holds: its view, its persisted state, and what its view shows. */
type TabContent = { view: WebContentsView; state: ExtensionState; page: TabPage };

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
    showSaveDialog: (options) => dialog.showSaveDialog(owner, options)
  };
}

/** Serve the app: `pageFor` builds the page a URL of it asks for, or answers
 *  null for a URL that is no page. */
function serveApp(pageFor: (url: URL) => PageContent | null): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response(null, { status: 404 });
    const content = pageFor(url);
    if (content !== null) {
      return new Response(buildDesktopPage(currentTheme(), content), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
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

/** The page in `contents`, as a webview instance talks to it; `deliver` hands
 *  it what the page posted, and `prompt` shows it one of the instance's
 *  prompts, on the same channel as the graph's messages (ADR-0031). */
function channelTo(contents: WebContents, logger: HostLogger) {
  let listener: ((message: RequestMessage) => void | Promise<void>) | null = null;
  const send = (message: unknown): boolean => {
    if (contents.isDestroyed()) return false;
    contents.send(CHANNELS.hostMessage, message);
    return true;
  };
  const channel: WebviewChannel = {
    onDidReceiveMessage: (l) => {
      listener = l;
    },
    postMessage: (message) => Promise.resolve(send(message))
  };
  const prompt = (message: HostPromptMessage) => {
    send(message);
  };
  const deliver = (message: RequestMessage) => {
    // A handler that throws has no one else to tell: the dispatch answers what
    // it catches, and this is what it did not.
    Promise.resolve(listener?.(message)).catch((e: unknown) =>
      logger.logError(`webview: handling "${message.command}" failed: ${String(e)}`)
    );
  };
  return { channel, deliver, prompt };
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
  /** Why the Welcome page shows no repository: a launch named a path that is
   *  none. Said only while no Tab is open, and forgotten once one is. */
  let welcomeNotice: Notice | null = null;
  /** The window's page has said it listens, since it last started loading. */
  let windowListening = false;
  /** Asked on the Welcome page, when there is no Tab to ask in: #394's and
   *  #396's commands ask here. */
  let welcomePrompts: DesktopPrompts | null = null;
  /** The Tab whose view last had the keyboard handed to it. */
  let keyboardTab: number | null = null;

  const tabs = createTabs<TabContent>({
    dispose: (content) => disposeTab(content),
    onChange: () => tabsChanged()
  });

  /** The Tab whose view's page is `contents`. */
  const tabOf = (contents: WebContents): Tab<TabContent> | null =>
    tabs.list().find((tab) => tab.content.view.webContents === contents) ?? null;
  /** The webview instance of the focused Tab: the menu's commands run there. */
  const focusedInstance = () => tabs.focused()?.content.page.instance ?? null;

  /** The application menu, built anew for what the window shows now: which
   *  entries are enabled is the template's to say (appMenu.ts). Not before the
   *  shared services, whose language it speaks. */
  const syncMenu = () => {
    if (shared === null) return;
    const template = appMenuTemplate(
      shared.l10n,
      {
        // The focused Tab's, looked up when clicked: a click handed no window
        // still finds it (#396).
        fetchRemote: () => void focusedInstance()?.fetchRemote(),
        openSettings: () => settingsWindow?.open()
      },
      process.platform,
      { hasGraph: focusedInstance() !== null }
    );
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  /** Tell the window's page the Tabs and what the Welcome page says, once it
   *  listens. */
  const postWindowState = () => {
    if (!windowListening || win === null || shared === null) return;
    const repos = shared.repoSource.getRepos();
    const focused = tabs.focused();
    const message: WindowStateMessage = {
      command: "windowState",
      tabs: tabs.list().map((tab) => ({
        id: tab.id,
        title: repos[tab.repo]?.customName || path.basename(tab.repo),
        tooltip: tab.repo,
        focused: tab === focused,
        asking: tab.content.page.asking
      })),
      notice: tabs.list().length === 0 ? welcomeNotice : null,
      strings: { closeTab: shared.l10n.t("desktop.tab.close") }
    };
    win.webContents.send(CHANNELS.hostMessage, message);
  };

  /** Lay the Tabs' views out below the strip, the focused one alone in the
   *  window; the Welcome page shows where none is. The others are taken out
   *  of the window rather than hidden in it: nothing draws a view that is in
   *  no window. Each keeps the window's size all the same: a graph sizes what
   *  it loads by its viewport. */
  const layoutTabs = () => {
    if (win === null || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const focused = tabs.focused();
    const shown = win.contentView.children;
    for (const tab of tabs.list()) {
      const { view } = tab.content;
      view.setBounds({
        x: 0,
        y: TAB_STRIP_HEIGHT,
        width,
        height: Math.max(0, height - TAB_STRIP_HEIGHT)
      });
      if (tab !== focused) {
        if (shown.includes(view)) win.contentView.removeChildView(view);
      } else if (!shown.includes(view)) {
        win.contentView.addChildView(view);
      }
    }
    // The keyboard goes where the user's eyes do: to the Tab brought forward.
    if (focused !== null && focused.id !== keyboardTab) focused.content.view.webContents.focus();
    keyboardTab = focused?.id ?? null;
  };

  const tabsChanged = () => {
    layoutTabs();
    postWindowState();
    syncMenu();
    shared?.tabStates.save(
      tabs.list().map((tab) => tab.content.state),
      tabs.focused()?.content.state ?? null
    );
  };

  /** A Tab is done: what its view showed, and the view. */
  function disposeTab({ view, page }: TabContent): void {
    page.instance?.dispose();
    page.prompts?.dispose();
    if (win !== null && !win.isDestroyed() && win.contentView.children.includes(view)) {
      win.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /** A view for a Tab, not yet in the window nor loaded: its page's URL names
   *  the Tab, which does not exist yet. `layoutTabs` puts it in the window. */
  const makeView = (): WebContentsView => {
    const view = new WebContentsView({ webPreferences: WEB_PREFERENCES });
    view.setBackgroundColor(currentTheme().background);
    // The page starting to load, the first time or again (a reload): the
    // graph it brings has yet to pick its repository. Tied to the load, not
    // to building the HTML, which a second fetch of it would repeat.
    view.webContents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      const loading = tabOf(view.webContents)?.content.page;
      loading?.instance?.pageLoading();
      loading?.prompts?.pageLoading();
    });
    return view;
  };

  /** A graph on `repo` in `view`, its Current repository persisted in `state`. */
  const graphPage = (
    host: SharedServices,
    owner: BrowserWindow,
    view: WebContentsView,
    repo: string,
    state: ExtensionState
  ): TabPage => {
    const { channel, deliver, prompt } = channelTo(view.webContents, logger);
    // Asked in this Tab's page: a prompt git raises for it comes back here
    // through its askpass route, whichever Tab is in front (#393).
    const prompts = createDesktopPrompts({
      dialogs: dialogsFor(owner),
      l10n: host.l10n,
      logger,
      page: { post: prompt },
      onAsking: (asking) => {
        page.asking = asking;
        postWindowState();
      }
    });
    const instance = createGraphInstance(host, {
      repo,
      channel,
      prompts,
      extensionState: state,
      revealSetting: (key) => settingsWindow?.reveal(key)
    });
    const strings = getWebviewLocalizedStrings((key) => host.l10n.t(key));
    const page: TabPage = {
      page: () => ({
        graph: { viewState: instance.pageViewState(), l10n: strings, nonce: getNonce() }
      }),
      instance,
      prompts,
      // The page's replies to the prompts are not requests: the dispatch never
      // sees them (ADR-0031).
      deliver: (message) => {
        if (isHostPromptReply(message)) prompts.receive(message);
        else deliver(message);
      },
      asking: false
    };
    return page;
  };

  /** In place of a graph, why there is none. Nothing on it should post
   *  anything; whatever does is said in the log. */
  const noticePage = (notice: Notice): TabPage => ({
    page: () => ({ notice }),
    instance: null,
    prompts: null,
    deliver: (message) =>
      logger.log(`webview: "${String(message?.command)}" reached a page with no graph`),
    asking: false
  });

  const loadTab = (tab: Tab<TabContent>) =>
    void tab.content.view.webContents.loadURL(
      `${PAGE_URL}${TAB_PATH.slice(1)}?${TAB_ID_PARAM}=${tab.id}`
    );

  /** Open `repo` — a repository, checked — in a Tab of its own, or focus the
   *  Tab it is open in. A Tab that could not show it when the app started
   *  shows it now. */
  const openRepo = (repo: string) => {
    if (shared === null || win === null) return;
    const host = shared;
    const owner = win;
    welcomeNotice = null;
    host.repoSource.addRepo(repo);
    const existing = tabs.find(repo);
    if (existing !== null && existing.content.page.instance === null) {
      existing.content.state.setLastActiveRepo(repo);
      existing.content.page = graphPage(
        host,
        owner,
        existing.content.view,
        repo,
        existing.content.state
      );
      loadTab(existing);
    }
    const { tab, opened } = tabs.open(repo, () => {
      const view = makeView();
      const state = host.tabStates.newTab(repo);
      return { view, state, page: graphPage(host, owner, view, repo, state) };
    });
    if (opened) loadTab(tab);
  };

  /** The Tabs the app was left with, in their order, the one in front again in
   *  front. A Tab whose folder is not there today says so in its place, and is
   *  kept until it is closed: the disk may only be unmounted (GLOSSARY.md's
   *  Current repository). */
  const restoreTabs = () => {
    if (shared === null || win === null) return;
    const host = shared;
    const owner = win;
    const { tabs: states, active } = host.tabStates.restore();
    let front: Tab<TabContent> | null = null;
    for (const state of states) {
      const persisted = state.getPersistedRepoPath();
      // A write refused (`setLastActiveRepo`) left nothing to show.
      if (persisted === null || tabs.find(persisted) !== null) continue;
      const repo = state.getLastActiveRepo();
      if (repo === null) {
        logger.log(`tabs: cannot restore ${persisted}, its folder is not there`);
      } else {
        logger.log(`tabs: restoring ${repo}`);
        host.repoSource.addRepo(repo);
      }
      const { tab } = tabs.open(persisted, () => {
        const view = makeView();
        const page =
          repo === null
            ? noticePage({
                title: host.l10n.t("error.unableToLoadGitGraph"),
                detail: host.l10n.t("desktop.cannotOpenRepo", persisted)
              })
            : graphPage(host, owner, view, repo, state);
        return { view, state, page };
      });
      loadTab(tab);
      if (state === active) front = tab;
    }
    if (front !== null) tabs.focus(front.id);
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
    if (shared === null || win === null || target === null) return;
    const host = shared;
    if ("unusable" in target) {
      logger.log(`launch: cannot open ${target.unusable}, not a Git repository`);
      const notice: Notice = {
        title: host.l10n.t("error.unableToLoadGitGraph"),
        detail: host.l10n.t("desktop.cannotOpenRepo", target.unusable)
      };
      if (tabs.list().length === 0) {
        welcomeNotice = notice;
        postWindowState();
      } else {
        void dialogsFor(win).showMessageBox({
          type: "error",
          message: notice.title,
          detail: notice.detail
        });
      }
      return;
    }
    // The repository as a Tab or the known set spells it, if it is open or
    // known under another spelling (a symlink, say): otherwise it would open
    // in a second Tab, or be known twice, the second time with none of its
    // state.
    const repo =
      resolveToKnownRepo(target.repo, [
        ...tabs.list().map((tab) => tab.repo),
        ...Object.keys(host.repoSource.getRepos())
      ]) ?? target.repo;
    logger.log(`launch: opening ${repo}`);
    openRepo(repo);
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
        break;
      case "focusTab":
        tabs.focus(message.id);
        break;
      case "closeTab":
        tabs.close(message.id);
        break;
    }
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
      void check(request).then(open);
    }
    if (win !== null) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  ipcMain.on(CHANNELS.webviewMessage, (event, message: RequestMessage | HostPromptReply) => {
    // The settings window's page talks to the settings, never to an instance.
    if (settingsWindow?.deliver(event.sender, message)) return;
    if (win !== null && event.sender === win.webContents) {
      fromWindowPage(message);
      return;
    }
    tabOf(event.sender)?.content.page.deliver(message);
  });

  app.on("window-all-closed", () => app.quit());
  // The log is written out before the process goes: quitting waits once for
  // it, then goes on.
  let logClosed = false;
  app.on("will-quit", (event) => {
    if (logClosed) return;
    event.preventDefault();
    // Not closed one by one: the Tabs as they stand are what the next
    // session opens.
    tabs.disposeAll();
    welcomePrompts?.dispose();
    shared?.dispose();
    void logger.close().finally(() => {
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
      clipboard: createDesktopClipboard(clipboard)
    });
    shared = host;
    nativeTheme.themeSource = readThemeChoice(host.storage.global);

    const handleSettings = createSettingsPageHandler({
      config: host.config,
      settings: host.settings,
      l10n: host.l10n,
      logger,
      instances: () =>
        tabs
          .list()
          .flatMap((tab) => (tab.content.page.instance ? [tab.content.page.instance] : [])),
      setTheme: (choice) => {
        nativeTheme.themeSource = choice;
        void writeThemeChoice(host.storage.global, choice);
      }
    });
    settingsWindow = createSettingsWindow({
      url: `${PAGE_URL}${SETTINGS_PATH.slice(1)}`,
      createWindow,
      handle: handleSettings,
      opener: host.opener,
      logger,
      // Only ever a key the app has: the one Show Setting names.
      valueOf: (key) => host.settings.get(key)
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
      if (url.pathname === TAB_PATH) {
        const id = Number(url.searchParams.get(TAB_ID_PARAM));
        const tab = tabs.list().find((t) => t.id === id);
        return tab?.content.page.page() ?? { notice: null };
      }
      return null;
    });
    followSystemTheme((theme) => {
      for (const tab of tabs.list()) tab.content.view.setBackgroundColor(theme.background);
    });
    // A Tab's title is its repository's custom name, when it has one.
    host.repoSource.onDidChangeRepos(postWindowState);

    const owner = createWindow();
    win = owner;
    welcomePrompts = createDesktopPrompts({
      dialogs: dialogsFor(owner),
      l10n: host.l10n,
      logger,
      page: {
        post: (message) => {
          if (!owner.webContents.isDestroyed()) {
            owner.webContents.send(CHANNELS.hostMessage, message);
          }
        }
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
    owner.on("closed", () => {
      tabs.disposeAll();
      welcomePrompts?.dispose();
      win = null;
    });
    void owner.loadURL(PAGE_URL);
    restoreTabs();
    open(await launchTarget);
  });
} else {
  // Another GING holds the lock and has been handed `thisLaunch`.
  app.quit();
}
