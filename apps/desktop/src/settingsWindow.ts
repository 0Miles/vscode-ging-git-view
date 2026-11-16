/* The window the desktop app's settings open in (#397): one at most, brought
 * forward when asked for again. Its page is a page kind of the desktop entry
 * (`data-ging-page="settings"`), served at `ging://app/settings`; what the page
 * asks is answered by `createSettingsPageHandler`. */

import type { BrowserWindow, WebContents } from "electron";

import type { HostLogger, Opener } from "@ging/core/host/ports";
import { isWebUrl } from "@ging/shared/webUrl";
import type { SettingsResponse } from "@ging/webview/desktop/settings/protocol";

import { CHANNELS } from "./channels";

export type SettingsWindow = {
  /** Open the settings, or bring the window they are in forward. */
  open(): void;
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

  const open = () => {
    if (win !== null) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
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
    void opened.loadURL(url);
  };

  return {
    open,
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
