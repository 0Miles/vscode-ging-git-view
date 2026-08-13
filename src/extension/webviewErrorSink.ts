import type { WebviewErrorReport } from "@/types";

/** Where a webview failure happened, in the log's own words. */
function location(report: WebviewErrorReport): string {
  if (report.command !== null) return 'while handling "' + report.command + '"';
  return report.origin === "uncaught" ? "uncaught" : "unhandled rejection";
}

/** One log line (stack included — it carries its own newlines, which the
 *  channel renders as written). */
export function formatWebviewError(report: WebviewErrorReport): string {
  // A V8 stack already opens with the message, so printing both would say it
  // twice; anything else (a thrown string, an Error without a stack) has only
  // the message to give.
  const detail =
    report.stack === null
      ? report.message
      : report.stack.startsWith(report.message)
        ? report.stack
        : report.message + "\n" + report.stack;
  return "webview " + location(report) + ": " + detail;
}

/**
 * The two surfaces a webview failure reaches, and the rules that keep each of
 * them readable (ADR-0016).
 *
 * They are deliberately different rules, because the surfaces answer different
 * questions. The log answers "what broke, exactly?" — the second identical
 * stack adds nothing and a failure inside a render loop would bury the git
 * commands around it, so identical lines are written once. The user's
 * notification answers "did what I just did finish?" — and every occurrence is
 * a fresh no, so repetition is not suppressed there; only stacking is, by
 * keeping at most one notification on screen at a time.
 */
export function createWebviewErrorSink(deps: {
  log: (line: string) => void;
  /** Tell the user something did not finish. Resolves once the notification is
   *  gone — dismissed or acted on — which is what bounds the next one. */
  notify: () => Promise<void>;
}) {
  const logged = new Set<string>();
  let notifying = false;

  return (report: WebviewErrorReport) => {
    const line = formatWebviewError(report);
    if (!logged.has(line)) {
      logged.add(line);
      deps.log(line);
    }
    // A failure the user has not acknowledged yet is not worth saying twice
    // over: the second toast tells them nothing the first one didn't, and the
    // pair of them is how a user learns to dismiss these unread.
    if (notifying) return;
    notifying = true;
    void deps.notify().finally(() => {
      notifying = false;
    });
  };
}
