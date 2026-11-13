/** The IPC channels between the main process and a window's preload. */
export const CHANNELS = {
  /** main → preload: the system theme changed; carries the new `Theme`. */
  theme: "ging:theme",
  /** preload → main: a message the webview posted through `acquireVsCodeApi`. */
  webviewMessage: "ging:webview-message"
} as const;
