import * as vscode from "vscode";

import { formatGitCommandArgs } from "@/backend/utils/gitCommandLog";

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}
function pad3(n: number): string {
  return (n < 10 ? "00" : n < 100 ? "0" : "") + n;
}

/** Writes timestamped log lines (git commands and core extension events) to the
 *  GING Output Channel. */
export type Logger = ReturnType<typeof createLogger>;

export function createLogger(channel: vscode.OutputChannel) {
  function log(message: string) {
    const d = new Date();
    const timestamp =
      d.getFullYear() +
      "-" +
      pad2(d.getMonth() + 1) +
      "-" +
      pad2(d.getDate()) +
      " " +
      pad2(d.getHours()) +
      ":" +
      pad2(d.getMinutes()) +
      ":" +
      pad2(d.getSeconds()) +
      "." +
      pad3(d.getMilliseconds());
    channel.appendLine("[" + timestamp + "] " + message);
  }

  return {
    log,
    /** Log the execution of a spawned git command. */
    logCmd(command: string, args: string[]) {
      log("> " + command + " " + formatGitCommandArgs(args));
    },
    logError(message: string) {
      log("ERROR: " + message);
    },
    /** Bring the channel into view — what the "show log" action on the webview
     *  failure notification does (ADR-0016). */
    reveal() {
      channel.show();
    }
  };
}
