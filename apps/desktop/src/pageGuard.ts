/* What keeps a page of the app where it was put: the page the main process
 * loaded in a window or a Tab's view, and nothing a link or a script in it
 * asks for in its place (#393). A Tab's view navigated to `?id=M` would draw
 * Tab M's graph while its messages still reach its own instance. The one
 * guard of every page of the app — each window's, each Tab's, the settings'
 * (#391). */

import type { WebContents } from "electron";

import type { Opener } from "@ging/core/host/ports";

/** Keep `contents` on the page the main process loads in it: no new window
 *  opens, and the page is never navigated away. What a link or `window.open`
 *  asked for is handed to `opener`, which alone decides what leaves the app —
 *  a web address, for the desktop's (`openWebUrl`), and nothing else. A reload,
 *  and the main process's own `loadURL`, are no navigation the page asked for,
 *  so they still go ahead. */
export function keepPageInPlace(
  contents: Pick<WebContents, "setWindowOpenHandler" | "on">,
  opener: Pick<Opener, "openExternalUrl">
): void {
  contents.setWindowOpenHandler(({ url }) => {
    opener.openExternalUrl(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    opener.openExternalUrl(event.url);
  });
}
