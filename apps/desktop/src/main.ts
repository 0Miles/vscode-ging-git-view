/* The desktop host's main process (#291). This is its skeleton (#386): one
 * window showing the webview's desktop entry, themed after the system, and a
 * single instance that takes the command lines of later launches. Opening a
 * repository and answering the webview come with #388. */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol } from "electron";

import { CHANNELS } from "./channels";
import {
  type LaunchCommandLine,
  type LaunchRequest,
  parseForwardedLaunch,
  parseLaunchArgs
} from "./launchArgs";
import { log } from "./log";
import { buildDesktopPage, PAGE_ASSETS } from "./page";
import { type Theme, themeFor } from "./theme";

/**
 * The page and its files are served from `ging://app/`, not `file://`: a
 * standard, secure scheme gives the page a real origin of its own — the
 * webview's storage needs one, and its content security policy can say 'self'
 * — while the main process decides exactly which files are reachable.
 */
const SCHEME = "ging";
const HOST = "app";
const PAGE_URL = `${SCHEME}://${HOST}/`;
/** Path on `ging://app` → file in out/, next to this bundle. Nothing else is served. */
const SERVED_FILES = new Map<string, string>([
  [`/${PAGE_ASSETS.stylesheet}`, PAGE_ASSETS.stylesheet],
  [`/${PAGE_ASSETS.script}`, PAGE_ASSETS.script],
  [`/${PAGE_ASSETS.script}.map`, `${PAGE_ASSETS.script}.map`]
]);

function currentTheme(): Theme {
  return themeFor(nativeTheme.shouldUseDarkColors ? "dark" : "light", process.platform);
}

/** A launch's request, this process's own or a later one's. Logged only, for
 *  now: what opening the repository means is #388's. */
function handleLaunch(request: LaunchRequest): void {
  if (request.ignored.length > 0) {
    log.warn(`launch: ignored arguments ${JSON.stringify(request.ignored)}`);
  }
  if (request.repo !== null) log.info(`launch: repository ${request.repo}`);
}

function serveApp(): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host === HOST && url.pathname === "/") {
      return new Response(buildDesktopPage(currentTheme()), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    const file = url.host === HOST ? SERVED_FILES.get(url.pathname) : undefined;
    if (file === undefined) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, file)).href);
  });
}

function createWindow(): void {
  const theme = currentTheme();
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Painted before the page is, so the window does not flash the wrong colour.
    backgroundColor: theme.variables["--vscode-editor-background"],
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  void win.loadURL(PAGE_URL);
}

/** Every window follows the system's theme as it changes (#397 adds a choice). */
function followSystemTheme(): void {
  nativeTheme.on("updated", () => {
    const theme = currentTheme();
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(theme.variables["--vscode-editor-background"]);
      win.webContents.send(CHANNELS.theme, theme);
    }
  });
}

const thisLaunch: LaunchCommandLine = { argv: process.argv, workingDirectory: process.cwd() };
const defaultApp = process.defaultApp === true;

if (app.requestSingleInstanceLock(thisLaunch)) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true } }
  ]);

  handleLaunch(parseLaunchArgs(thisLaunch, { defaultApp }));
  // The later launch's own command line, not the `argv` beside it: see LaunchCommandLine.
  app.on("second-instance", (_event, _argv, _workingDirectory, data) => {
    const request = parseForwardedLaunch(data, { defaultApp });
    if (request === null) log.warn("launch: a later launch forwarded nothing readable");
    else handleLaunch(request);
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.on(CHANNELS.webviewMessage, (_event, message: { command?: unknown }) => {
    log.info(`webview: "${String(message?.command)}" has no handler yet (#388)`);
  });

  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(() => {
    serveApp();
    followSystemTheme();
    createWindow();
  });
} else {
  // Another GING holds the lock and has been handed `thisLaunch`.
  app.quit();
}
