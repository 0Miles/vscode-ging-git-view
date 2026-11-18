import type { RequestMessage } from "@ging/shared/types";
import { vscode } from "@ging/webview/utils/vscode";

/** Post one of the desktop's own messages where the graph posts its requests.
 *  Not a `RequestMessage`, and never handled as one (ADR-0031). The cast is
 *  what that costs: the host API is typed for the graph's requests, and
 *  widening it to the desktop's would put them in the protocol both entries
 *  share. Each screen narrows it to its own requests. */
export function postToHost(message: { command: string }): void {
  vscode.postMessage(message as unknown as RequestMessage);
}
