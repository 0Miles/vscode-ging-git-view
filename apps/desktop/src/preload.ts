/* Runs in each window before the page's own scripts, in an isolated world.
 * The webview calls `acquireVsCodeApi()` while its bundle is being evaluated
 * (ADR-0031), so this is where the desktop host supplies it. */

import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS } from "./channels";
import { applyTheme, type Theme } from "./theme";

/** What `setState` was last given. It lives as long as the page does, which is
 *  what VS Code promises a webview without a serializer; surviving a restart is
 *  `HostStorage`'s job (#387), not this. */
let state: unknown;

const api = Object.freeze({
  postMessage: (message: unknown) => ipcRenderer.send(CHANNELS.webviewMessage, message),
  getState: () => state,
  setState: (next: unknown) => {
    state = next;
  }
});

contextBridge.exposeInMainWorld("acquireVsCodeApi", () => api);

ipcRenderer.on(CHANNELS.theme, (_event, theme: Theme) => applyTheme(document, theme));
