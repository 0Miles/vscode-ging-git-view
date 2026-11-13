/* The desktop entry: the webview bundle only the desktop host ships
 * (`apps/desktop`, #386). Desktop-only screens and the listener for the
 * desktop host's own messages come in through here and nowhere else
 * (ADR-0031). Today it is the graph view and the marker. */

import { startGitGraphView } from "@ging/webview/gitGraphView";

/** Which entry the page loaded, for the desktop host's E2E to read (#386).
 *  The extension's bundle must never contain it
 *  (`apps/vscode/tests/backend/webviewEntries.test.ts`). */
const DESKTOP_ENTRY_MARKER = "ging-desktop-entry";

document.documentElement.dataset.gingEntry = DESKTOP_ENTRY_MARKER;
// The host writes `viewState` only into a page for a repository it opened. A
// page without one — nothing asked for, or a path that is not a repository
// (#388) — has no graph to start: built from nothing, it would only throw.
if (typeof viewState !== "undefined") startGitGraphView();
