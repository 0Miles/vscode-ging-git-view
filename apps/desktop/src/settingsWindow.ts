/* The window the desktop app's settings open in (#397): one at most, brought
 * forward when asked for again. Its page is a page kind of the desktop entry
 * (`data-ging-page="settings"`), served at `ging://app/settings`; what the page
 * asks is answered by `createSettingsPageHandler`. */

import type { BrowserWindow, WebContents } from "electron";

import type { HostLogger, Opener } from "@ging/core/host/ports";
import {
  SETTING_PARAM,
  type SettingsHostMessage,
  type SettingsResponse
} from "@ging/webview/desktop/settings/protocol";

import { CHANNELS } from "./channels";
import { keepPageInPlace } from "./pageGuard";

export type SettingsWindow = {
  /** Open the settings, or bring the window they are in forward. */
  open(): void;
  /** Open the settings at setting `key`'s row, or bring the window forward
   *  and show that row there, with the value the app holds now — a write made
   *  elsewhere since included. An open window is not reloaded: what is typed
   *  and not yet sent in its other rows stays. */
  reveal(key: string): void;
  /** Show an open window the value setting `key` holds now, as written —
   *  over whatever is typed and not yet sent in that row, since sending it
   *  would write over the new value (#446). Nothing, when no window is open:
   *  one opened later is served the value then. */
  updated(key: string): void;
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
  logger,
  valueOf
}: {
  /** The settings page's address. */
  url: string;
  /** What the app holds for setting `key` now, as the page shows it. */
  valueOf: (key: string) => unknown;
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
    // A link to another setting moves within the page, which is no navigation;
    // anything else stays as every page of the app does: what leaves it is the
    // opener's to decide.
    keepPageInPlace(opened.webContents, opener);
    opened.on("closed", () => {
      win = null;
    });
    void opened.loadURL(at);
  };

  /** Send `message` to the page of `shown`, unless it is gone. */
  const send = (shown: BrowserWindow, message: SettingsHostMessage) => {
    if (!shown.webContents.isDestroyed()) shown.webContents.send(CHANNELS.hostMessage, message);
  };
  /** Tell the page of `shown` the value `key` holds now. */
  const pushValue = (shown: BrowserWindow, key: string) =>
    send(shown, { command: "settingUpdated", key, value: valueOf(key), error: null });

  return {
    open: () => {
      if (raise() === null) create(url);
    },
    reveal: (key) => {
      const shown = raise();
      if (shown === null) {
        // A new page, which scrolls the setting its query names into view.
        create(`${url}?${SETTING_PARAM}=${encodeURIComponent(key)}`);
        return;
      }
      // Not reloaded, which would drop what is typed and not yet sent in its
      // other rows: told the value now, then to show the row.
      pushValue(shown, key);
      send(shown, { command: "revealSetting", key });
    },
    updated: (key) => {
      if (win !== null) pushValue(win, key);
    },
    deliver(sender, message) {
      if (win === null || sender !== win.webContents) return false;
      const shown = win;
      const reply = (answer: SettingsResponse) => send(shown, answer);
      handle(message, reply).catch((e: unknown) =>
        logger.logError(`settings: handling a message failed: ${String(e)}`)
      );
      return true;
    }
  };
}
