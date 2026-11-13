/* The desktop host's main process (#291): one window showing the webview's
 * desktop entry, themed after the system, and a single instance that takes
 * the command lines of later launches (#386). The window shows a graph on the
 * repository a launch names, through one webview instance with a dispatch of
 * its own over the services instances share (#388); #393 gives each tab one. */

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  shell,
  type WebContents
} from "electron";

import { getNonce } from "@ging/core/backend/utils/nonce";
import type { WebviewChannel } from "@ging/core/extension/webviewBridge";
import type { HostLogger } from "@ging/core/host/ports";
import type { RequestMessage } from "@ging/shared/types";
import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";

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
import { createDesktopClipboard } from "./ports/clipboard";
import { createDesktopLogger } from "./ports/logger";
import { createInterimPrompts } from "./ports/prompts";
import { repoToOpen } from "./repoToOpen";
import { createSharedHost, type SharedHost } from "./sharedHost";
import { type Theme, themeFor } from "./theme";

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
/** The query parameter carrying the id of what a load of the page shows
 *  (`Shown.id`), so a load of a replaced page can be told from the current. */
const PAGE_ID_PARAM = "page";
/** The files in out/, next to this bundle, that `ging://app/<file>` serves:
 *  the page's assets and the script's source map. Nothing else is served. */
const SERVED_FILES = new Set<string>([...Object.values(PAGE_ASSETS), `${PAGE_ASSETS.script}.map`]);

function currentTheme(): Theme {
  return themeFor(nativeTheme.shouldUseDarkColors ? "dark" : "light", process.platform);
}

/** What the window shows: a page, built anew at each load, and the webview
 *  instance answering it when it is a graph. `id` tells a load of this page
 *  from a load of the one it replaced. */
type Shown = {
  id: number;
  page: () => PageContent;
  instance: GraphInstance | null;
  /** Hand the instance a message its page posted. */
  deliver: (message: RequestMessage) => void;
};

/** Report what a launch asked for, and what it asked to open, if anything. */
function logLaunch(request: LaunchRequest, logger: HostLogger): void {
  if (request.ignored.length > 0) {
    logger.log(`launch: ignored arguments ${JSON.stringify(request.ignored)}`);
  }
  if (request.repo !== null) logger.log(`launch: repository ${request.repo}`);
}

function serveApp(pageFor: (id: string | null) => PageContent): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response(null, { status: 404 });
    if (url.pathname === "/") {
      return new Response(
        buildDesktopPage(currentTheme(), pageFor(url.searchParams.get(PAGE_ID_PARAM))),
        {
          headers: { "content-type": "text/html; charset=utf-8" }
        }
      );
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
}

/** Every window follows the system's theme as it changes (#397 adds a choice). */
function followSystemTheme(): void {
  nativeTheme.on("updated", () => {
    const theme = currentTheme();
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(theme.background);
      win.webContents.send(CHANNELS.theme, theme);
    }
  });
}

/** The page in `contents`, as a webview instance talks to it; `deliver` hands
 *  it what the page posted. */
function channelTo(contents: WebContents, logger: HostLogger) {
  let listener: ((message: RequestMessage) => void | Promise<void>) | null = null;
  const channel: WebviewChannel = {
    onDidReceiveMessage: (l) => {
      listener = l;
    },
    postMessage: (message) => {
      if (contents.isDestroyed()) return Promise.resolve(false);
      contents.send(CHANNELS.hostMessage, message);
      return Promise.resolve(true);
    }
  };
  const deliver = (message: RequestMessage) => {
    // A handler that throws has no one else to tell: the dispatch answers what
    // it catches, and this is what it did not.
    Promise.resolve(listener?.(message)).catch((e: unknown) =>
      logger.logError(`webview: handling "${message.command}" failed: ${String(e)}`)
    );
  };
  return { channel, deliver };
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

  let shared: SharedHost | null = null;
  let win: BrowserWindow | null = null;
  let shown: Shown | null = null;
  let nextId = 0;

  /** Whatever the window shows is done: its instance, if any, disposed. */
  const closeShown = () => {
    shown?.instance?.dispose();
    shown = null;
  };

  /** Put `page` in the window, answered by `instance` if it is a graph; the
   *  instance shown before is done. */
  const show = (
    page: () => PageContent,
    instance: GraphInstance | null,
    deliver: Shown["deliver"]
  ) => {
    closeShown();
    shown = { id: ++nextId, page, instance, deliver };
    void win?.loadURL(`${PAGE_URL}?${PAGE_ID_PARAM}=${shown.id}`);
  };

  /** A page with no graph, saying why when `notice` is not null. Nothing on
   *  it should post anything; whatever does is said in the log. */
  const showNotice = (notice: Notice | null) =>
    show(
      () => ({ notice }),
      null,
      (message) => logger.log(`webview: "${String(message?.command)}" reached a page with no graph`)
    );

  /** A graph on `repo`, in a webview instance of its own. */
  const showGraph = (host: SharedHost, owner: BrowserWindow, repo: string) => {
    const { channel, deliver } = channelTo(owner.webContents, logger);
    const instance = createGraphInstance(host, {
      repo,
      channel,
      prompts: createInterimPrompts({
        // Looked up when called, so the E2E can answer in their place (ADR-0032).
        dialogs: {
          showMessageBox: (options) => dialog.showMessageBox(owner, options),
          showSaveDialog: (options) => dialog.showSaveDialog(owner, options)
        },
        l10n: host.l10n,
        logger
      })
    });
    const strings = getWebviewLocalizedStrings((key) => host.l10n.t(key));
    show(
      () => ({ graph: { viewState: instance.pageViewState(), l10n: strings, nonce: getNonce() } }),
      instance,
      deliver
    );
  };

  /** Open what `request` names: its repository, or a notice that it is none.
   *  The notice takes the place only of a page with no graph: a later launch
   *  naming a bad path must not close the graph someone is using, so there it
   *  is said in a box over it. A request naming nothing changes nothing. */
  const open = async (request: LaunchRequest) => {
    if (shared === null || win === null || request.repo === null) return;
    const host = shared;
    const owner = win;
    const target = await repoToOpen(request.repo, host.gitPath());
    if ("unusable" in target) {
      logger.log(`launch: cannot open ${target.unusable}, not a Git repository`);
      const notice: Notice = {
        title: host.l10n.t("error.unableToLoadGitGraph"),
        detail: host.l10n.t("desktop.cannotOpenRepo", target.unusable)
      };
      if (!shown?.instance) showNotice(notice);
      else
        void dialog.showMessageBox(owner, {
          type: "error",
          message: notice.title,
          detail: notice.detail
        });
      return;
    }
    logger.log(`launch: opening ${target.repo}`);
    host.repoSource.addRepo(target.repo);
    host.extensionState.setLastActiveRepo(target.repo);
    showGraph(host, owner, target.repo);
  };

  const launch = parseLaunchArgs(thisLaunch, runtime);
  logLaunch(launch, logger);
  // The later launch's own command line, not the `argv` beside it: see LaunchCommandLine.
  app.on("second-instance", (_event, _argv, _workingDirectory, data) => {
    const request = parseForwardedLaunch(data, runtime);
    if (request === null) {
      logger.log("launch: a later launch forwarded nothing readable");
    } else {
      logLaunch(request, logger);
      // One window, one instance (B): a repository it names takes the
      // window's place. #393 opens it in a tab of its own instead.
      void open(request);
    }
    if (win !== null) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.on(CHANNELS.webviewMessage, (event, message: RequestMessage) => {
    if (shown === null || win === null || event.sender !== win.webContents) return;
    // Only from the page that is shown: one replaced but still unloading must
    // not reach the instance that replaced it.
    const frameUrl = event.senderFrame?.url ?? "";
    const id = URL.canParse(frameUrl) ? new URL(frameUrl).searchParams.get(PAGE_ID_PARAM) : null;
    if (id === String(shown.id)) shown.deliver(message);
  });

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    closeShown();
    shared?.dispose();
    void logger.close();
  });
  void app.whenReady().then(() => {
    // After ready: the locale is not known before it.
    shared = createSharedHost({
      userDataPath: app.getPath("userData"),
      locale: app.getLocale(),
      helperDir: __dirname,
      logger,
      clipboard: createDesktopClipboard(clipboard)
    });
    serveApp((id) => (shown !== null && id === String(shown.id) ? shown.page() : { notice: null }));
    followSystemTheme();
    win = createWindow();
    win.on("closed", () => {
      closeShown();
      win = null;
    });
    if (launch.repo === null) showNotice(null);
    else void open(launch);
  });
} else {
  // Another GING holds the lock and has been handed `thisLaunch`.
  app.quit();
}
