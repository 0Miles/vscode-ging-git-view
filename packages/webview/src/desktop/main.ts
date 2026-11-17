/* The desktop entry: the webview bundle only the desktop host ships
 * (`apps/desktop`, #386). Desktop-only screens and the listener for the
 * desktop host's own messages come in through here and nowhere else
 * (ADR-0031). Today: the graph view, the marker, the host prompt overlay
 * (#390), the settings page (#397), the window's own page — the tab strip
 * and the Welcome page (#393) — and the working tree panel (#403). */

import type { RequestMessage } from "@ging/shared/types";
import { startGitGraphView } from "@ging/webview/gitGraphView";
import { sendMessage, vscode } from "@ging/webview/utils/vscode";

import { type HostPromptReply, isHostPromptMessage } from "./hostPrompt";
import { createHostPromptOverlay } from "./hostPromptOverlay";
import type { SettingsPageState } from "./settings/protocol";
import { startSettingsPage } from "./settings/settingsPage";
import { startWindowPage } from "./window/windowPage";
import { startWorkingTreePanel } from "./workingTree/workingTreePanel";

/** Which entry the page loaded, for the desktop host's E2E to read (#386).
 *  The extension's bundle must never contain it
 *  (`apps/vscode/tests/backend/webviewEntries.test.ts`). */
const DESKTOP_ENTRY_MARKER = "ging-desktop-entry";

/** A reply to the host's prompts, posted where the graph posts its requests.
 *  Not a `RequestMessage`, and never handled as one (ADR-0031). */
function replyToHost(reply: HostPromptReply) {
  // The cast is what ADR-0031 costs: the host API is typed for the graph's
  // requests, and widening it to the desktop's replies would put them in the
  // protocol both entries share.
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
// settings (#397), the window's own page (#393), or a notice in place of a
// graph, which has nothing to start.
switch (document.documentElement.dataset.gingPage) {
  case "graph":
    if (typeof viewState === "undefined") {
      reportMissing("graph page without a viewState");
    } else {
      startGitGraphView();
      // A graph page is one with a host instance behind it, and the instance
      // is what asks (#390). The settings page has none, so asks nothing.
      listenForHostPrompts();
      // Beside the graph, on its repository (#403).
      startWorkingTreePanel();
    }
    break;
  case "settings": {
    const state = (globalThis as { settingsPage?: SettingsPageState }).settingsPage;
    const root = document.getElementById("settings");
    if (state === undefined || root === null) reportMissing("settings page without its settings");
    else startSettingsPage(state, root);
    break;
  }
  case "window": {
    const strip = document.getElementById("tabStrip");
    const welcome = document.getElementById("welcome");
    if (strip === null || welcome === null) {
      reportMissing("window page without its tab strip or Welcome page");
    } else {
      startWindowPage(strip, welcome);
      // The Welcome page's prompts: the host asks there when no Tab is open
      // to ask in (#396). Any open Tab's view covers it, so only then.
      listenForHostPrompts();
    }
    break;
  }
}
