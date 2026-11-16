/* The desktop entry: the webview bundle only the desktop host ships
 * (`apps/desktop`, #386). Desktop-only screens and the listener for the
 * desktop host's own messages come in through here and nowhere else
 * (ADR-0031). Today: the graph view, the marker, and the host prompt overlay
 * (#390). */

import type { RequestMessage } from "@ging/shared/types";
import { startGitGraphView } from "@ging/webview/gitGraphView";
import { sendMessage, vscode } from "@ging/webview/utils/vscode";

import { type HostPromptReply, isHostPromptMessage } from "./hostPrompt";
import { createHostPromptOverlay } from "./hostPromptOverlay";

/** Which entry the page loaded, for the desktop host's E2E to read (#386).
 *  The extension's bundle must never contain it
 *  (`apps/vscode/tests/backend/webviewEntries.test.ts`). */
const DESKTOP_ENTRY_MARKER = "ging-desktop-entry";

/** A reply to the host's prompts, posted where the graph posts its requests.
 *  Not a `RequestMessage`, and never handled as one (ADR-0031). */
function replyToHost(reply: HostPromptReply) {
  vscode.postMessage(reply as unknown as RequestMessage);
}

/** Show the host's prompts as they arrive, and tell it the page is listening:
 *  it holds them back until then. Its messages reach the graph's listener too,
 *  which drops them; this one drops everything that is not a prompt. */
function listenForHostPrompts() {
  const overlay = createHostPromptOverlay((id, answer) =>
    replyToHost({ command: "hostPromptAnswer", id, answer })
  );
  window.addEventListener("message", (event: MessageEvent) => {
    if (isHostPromptMessage(event.data)) overlay.enqueue(event.data);
  });
  replyToHost({ command: "hostPromptReady" });
}

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
    // A graph page is one with a host instance behind it, and the instance is
    // what asks.
    listenForHostPrompts();
  }
}
