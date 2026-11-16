/* The desktop entry: the webview bundle only the desktop host ships
 * (`apps/desktop`, #386). Desktop-only screens and the listener for the
 * desktop host's own messages come in through here and nowhere else
 * (ADR-0031). Today it is the graph view, the settings page and the marker. */

import { startGitGraphView } from "@ging/webview/gitGraphView";
import { sendMessage } from "@ging/webview/utils/vscode";

import type { SettingsPageState } from "./settings/protocol";
import { startSettingsPage } from "./settings/settingsPage";

/** Which entry the page loaded, for the desktop host's E2E to read (#386).
 *  The extension's bundle must never contain it
 *  (`apps/vscode/tests/backend/webviewEntries.test.ts`). */
const DESKTOP_ENTRY_MARKER = "ging-desktop-entry";

document.documentElement.dataset.gingEntry = DESKTOP_ENTRY_MARKER;

/** A page its host served without what it boots from is the host's mistake.
 *  Said where it hears the webview's failures (ADR-0016), not left blank. */
function reportMissing(what: string): void {
  sendMessage({
    command: "reportError",
    report: {
      origin: "uncaught",
      command: null,
      message: `The desktop host served a ${what}`,
      stack: null
    }
  });
}

// The desktop host states which kind of page it served (#388): a graph, the
// settings (#397), or a notice in place of a graph, which has nothing to start.
switch (document.documentElement.dataset.gingPage) {
  case "graph":
    if (typeof viewState === "undefined") reportMissing("graph page without a viewState");
    else startGitGraphView();
    break;
  case "settings": {
    const state = (globalThis as { settingsPage?: SettingsPageState }).settingsPage;
    const root = document.getElementById("settings");
    if (state === undefined || root === null) reportMissing("settings page without its settings");
    else startSettingsPage(state, root);
    break;
  }
}
