/* The desktop entry: the webview bundle only the desktop host ships
 * (`apps/desktop`, #386). Desktop-only screens and the listener for the
 * desktop host's own messages come in through here and nowhere else
 * (ADR-0031). Today it is the graph view and the marker. */

import { startGitGraphView } from "@ging/webview/gitGraphView";
import { sendMessage } from "@ging/webview/utils/vscode";

/** Which entry the page loaded, for the desktop host's E2E to read (#386).
 *  The extension's bundle must never contain it
 *  (`apps/vscode/tests/backend/webviewEntries.test.ts`). */
const DESKTOP_ENTRY_MARKER = "ging-desktop-entry";

document.documentElement.dataset.gingEntry = DESKTOP_ENTRY_MARKER;

// The desktop host states which kind of page it served (#388): a graph, or a notice in
// its place, which has no graph to start.
if (document.documentElement.dataset.gingPage === "graph") {
  if (typeof viewState === "undefined") {
    // A graph page with nothing to boot from is the desktop host's mistake. Said
    // where it hears the webview's failures (ADR-0016), not left blank.
    sendMessage({
      command: "reportError",
      report: {
        origin: "uncaught",
        command: null,
        message: "The desktop host served a graph page without a viewState",
        stack: null
      }
    });
  } else {
    startGitGraphView();
  }
}
