import * as vscode from "vscode";

import { formatGitCommandArgs } from "@/backend/utils/gitCommandLog";
import type { WebviewErrorReport } from "@/types";

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}
function pad3(n: number): string {
  return (n < 10 ? "00" : n < 100 ? "0" : "") + n;
}

/** Where a webview failure happened, in the log's own words. */
function webviewErrorLocation(report: WebviewErrorReport): string {
  if (report.command !== null) return 'while handling "' + report.command + '"';
  return report.origin === "uncaught" ? "uncaught" : "unhandled rejection";
}

function formatWebviewError(report: WebviewErrorReport): string {
  // A V8 stack already opens with the message, so printing both would say it
  // twice; anything else (a thrown string, an Error without a stack) has only
  // the message to give.
  const detail =
    report.stack === null
      ? report.message
      : report.stack.startsWith(report.message)
        ? report.stack
        : report.message + "\n" + report.stack;
  return "webview " + webviewErrorLocation(report) + ": " + detail;
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
    /** Record a failure the webview could not handle. This channel is the only
     *  place such a failure is written down (ADR-0016), so the stack goes in
     *  whole — a bug report is assembled from what is here. */
    logWebviewError(report: WebviewErrorReport) {
      log("ERROR: " + formatWebviewError(report));
    },
    /** Bring the channel into view — what the "show log" action on the webview
     *  failure notification does. */
    reveal() {
      channel.show();
    }
  };
}
