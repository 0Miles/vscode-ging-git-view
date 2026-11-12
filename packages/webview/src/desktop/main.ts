/* The desktop entry: the webview bundle only the desktop host ships
 * (`apps/desktop`, #386). The VS Code entry, `../main.ts`, never imports this
 * file or anything under `desktop/`, so what lands here stays out of the
 * extension's bundle — the screens only the desktop host has (the host prompt
 * overlay, the Branches / Remotes side view, the working tree, the diff
 * viewer) and the listener for the messages only it sends (ADR-0031).
 *
 * Today it is the graph view and the marker, nothing else. */

import { startGitGraphView } from "@ging/webview/gitGraphView";

/** Which entry the page loaded, written where the desktop host's E2E can read
 *  it (#386) — and a string the extension's bundle must never contain, which
 *  `apps/vscode/tests/backend/webviewEntries.test.ts` holds it to. Written into
 *  the page rather than merely declared, so tree-shaking cannot drop it. */
const DESKTOP_ENTRY_MARKER = "ging-desktop-entry";

document.documentElement.dataset.gingEntry = DESKTOP_ENTRY_MARKER;
startGitGraphView();
