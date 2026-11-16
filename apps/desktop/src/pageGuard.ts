/* What keeps a page of the app where it was put: the page the main process
 * loaded in a window or a Tab's view, and nothing a link or a script in it
 * asks for in its place (#393). A Tab's view navigated to `?id=M` would draw
 * Tab M's graph while its messages still reach its own instance. */

import type { WebContents } from "electron";

import type { Opener } from "@ging/core/host/ports";
import { isWebUrl } from "@ging/shared/webUrl";

/** Keep `contents` on the page the main process loads in it: a link out to
 *  the web goes to `opener`, no new window opens, and the page is never
 *  navigated away. A reload, and the main process's own `loadURL`, are no
 *  navigation the page asked for, so they still go ahead. */
export function keepPageInPlace(
  contents: Pick<WebContents, "setWindowOpenHandler" | "on">,
  opener: Pick<Opener, "openExternalUrl">
): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) opener.openExternalUrl(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => event.preventDefault());
}
