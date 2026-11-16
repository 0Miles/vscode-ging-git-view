/* The window the desktop app's settings open in (#397): one at most, brought
 * forward when asked for again. Its page is a page kind of the desktop entry
 * (`data-ging-page="settings"`), served at `ging://app/settings`; what the page
 * asks is answered by `createSettingsPageHandler`. */

import type { BrowserWindow, WebContents } from "electron";

import type { HostLogger, Opener } from "@ging/core/host/ports";
import { isWebUrl } from "@ging/shared/webUrl";
import { SETTING_PARAM, type SettingsResponse } from "@ging/webview/desktop/settings/protocol";

import { CHANNELS } from "./channels";

export type SettingsWindow = {
  /** Open the settings, or bring the window they are in forward. */
  open(): void;
  /** Open the settings at setting `key`'s row, or bring the window forward
   *  and load them there anew: they are shown as they are now, a write made
   *  elsewhere since included. */
  reveal(key: string): void;
  /** Hand the settings a message `sender` posted; anything not from the
   *  settings window's page answers false and is left to whoever else it is
   *  for. */
  deliver(sender: WebContents, message: unknown): boolean;
};

export function createSettingsWindow({
  url,
  createWindow,
  handle,
  opener,
  logger
}: {
  /** The settings page's address. */
  url: string;
  /** A window as the app makes them: themed, with the preload. */
  createWindow: () => BrowserWindow;
  /** What the page posted, and how to answer it. */
  handle: (message: unknown, reply: (message: SettingsResponse) => void) => Promise<void>;
  /** A link out of the page — a description's link to the web — goes here;
   *  nothing else leaves the page. */
  opener: Pick<Opener, "openExternalUrl">;
  logger: Pick<HostLogger, "logError">;
}): SettingsWindow {
  let win: BrowserWindow | null = null;

  /** The window, brought forward; `null` when there is none yet. */
  const raise = (): BrowserWindow | null => {
    if (win === null) return null;
    if (win.isMinimized()) win.restore();
    win.focus();
    return win;
  };

  /** Open a window on `at`. */
  const create = (at: string) => {
    const opened = createWindow();
    win = opened;
    opened.webContents.setWindowOpenHandler(({ url: target }) => {
      if (isWebUrl(target)) opener.openExternalUrl(target);
      return { action: "deny" };
    });
    // A link to another setting moves within the page, which is no navigation;
    // anything that would replace the page is refused.
    opened.webContents.on("will-navigate", (event) => event.preventDefault());
    opened.on("closed", () => {
      win = null;
    });
    void opened.loadURL(at);
  };

  return {
    open: () => {
      if (raise() === null) create(url);
    },
    reveal: (key) => {
      // The page scrolls the setting its query names into view. A query, not
      // a fragment: a fragment's change does not load the page anew.
      const at = `${url}?${SETTING_PARAM}=${encodeURIComponent(key)}`;
      const shown = raise();
      if (shown === null) create(at);
      else void shown.loadURL(at);
    },
    deliver(sender, message) {
      if (win === null || sender !== win.webContents) return false;
      const contents = win.webContents;
      const reply = (answer: SettingsResponse) => {
        if (!contents.isDestroyed()) contents.send(CHANNELS.hostMessage, answer);
      };
      handle(message, reply).catch((e: unknown) =>
        logger.logError(`settings: handling a message failed: ${String(e)}`)
      );
      return true;
    }
  };
}
