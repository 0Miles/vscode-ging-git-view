/* The desktop host's main process (#291). This is its skeleton (#386): one
 * window showing the webview's desktop entry, themed after the system, and a
 * single instance that takes the command lines of later launches. Opening a
 * repository and answering the webview come with #388. */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, shell } from "electron";

import type { HostLogger } from "@ging/core/host/ports";

import { CHANNELS } from "./channels";
import {
  type LaunchCommandLine,
  type LaunchRequest,
  type LaunchRuntime,
  parseForwardedLaunch,
  parseLaunchArgs
} from "./launchArgs";
import { buildDesktopPage, PAGE_ASSETS } from "./page";
import { createDesktopLogger } from "./ports/logger";
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
/** The files in out/, next to this bundle, that `ging://app/<file>` serves:
 *  the page's assets and the script's source map. Nothing else is served. */
const SERVED_FILES = new Set<string>([...Object.values(PAGE_ASSETS), `${PAGE_ASSETS.script}.map`]);

function currentTheme(): Theme {
  return themeFor(nativeTheme.shouldUseDarkColors ? "dark" : "light", process.platform);
}

/** A launch's request, this process's own or a later one's. Logged only, for
 *  now: what opening the repository means is #388's. */
function handleLaunch(request: LaunchRequest, logger: HostLogger): void {
  if (request.ignored.length > 0) {
    logger.log(`launch: ignored arguments ${JSON.stringify(request.ignored)}`);
  }
  if (request.repo !== null) logger.log(`launch: repository ${request.repo}`);
}

function serveApp(): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response(null, { status: 404 });
    if (url.pathname === "/") {
      return new Response(buildDesktopPage(currentTheme()), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    const file = url.pathname.slice(1);
    if (!SERVED_FILES.has(file)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, file)).href);
  });
}

function createWindow(): void {
  const theme = currentTheme();
  const win = new BrowserWindow({
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
  void win.loadURL(PAGE_URL);
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

  handleLaunch(parseLaunchArgs(thisLaunch, runtime), logger);
  // The later launch's own command line, not the `argv` beside it: see LaunchCommandLine.
  app.on("second-instance", (_event, _argv, _workingDirectory, data) => {
    const request = parseForwardedLaunch(data, runtime);
    if (request === null) logger.log("launch: a later launch forwarded nothing readable");
    else handleLaunch(request, logger);
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.on(CHANNELS.webviewMessage, (_event, message: { command?: unknown }) => {
    logger.log(`webview: "${String(message?.command)}" has no handler yet (#388)`);
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
