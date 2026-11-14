/** The IPC channels between the main process and a window's preload. */
export const CHANNELS = {
  /** main → preload: the system theme changed; carries the new `Theme`. */
  theme: "ging:theme",
  /** preload → main: a message the webview posted through `acquireVsCodeApi`. */
  webviewMessage: "ging:webview-message",
  /** main → preload: a message for the webview, which the preload posts to the
   *  page as VS Code delivers a host's message. */
  hostMessage: "ging:host-message"
} as const;
