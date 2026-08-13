import type { WebviewErrorReport } from "@/types";

/** A thrown value in the shape the log needs. Only an `Error` carries a stack;
 *  everything else (a thrown string, a promise rejected with a plain object)
 *  gets its `String()` form, which is all that can be had without risking a
 *  second failure inside the reporter itself. */
function describeThrown(thrown: unknown): { message: string; stack: string | null } {
  if (thrown instanceof Error) {
    return { message: thrown.name + ": " + thrown.message, stack: thrown.stack ?? null };
  }
  return { message: String(thrown), stack: null };
}

export type ErrorReporter = ReturnType<typeof createErrorReporter>;

/**
 * The webview's one route out of silence: every failure it cannot handle is
 * described and sent to the host, which writes it to the GING Output Channel
 * (ADR-0016).
 *
 * Nothing here decides whether the user is told — that is the host's call, made
 * from `origin`. This side only guarantees the failure is described in full and
 * said out loud exactly once.
 */
export function createErrorReporter(send: (report: WebviewErrorReport) => void) {
  // Reported failures, keyed by everything the report carries. A failure inside
  // a render loop or a mousemove handler repeats as fast as the event does, and
  // a channel whose main content is git commands cannot absorb that. The first
  // occurrence carries the whole stack, which is what a bug report needs; the
  // identical ones after it are dropped.
  const reported = new Set<string>();

  function report(origin: WebviewErrorReport["origin"], command: string | null, thrown: unknown) {
    const { message, stack } = describeThrown(thrown);
    const key = [origin, command ?? "", message, stack ?? ""].join("\n");
    if (reported.has(key)) return;
    reported.add(key);
    send({ origin, command, message, stack });
  }

  return {
    /**
     * Apply one host→webview message, reporting anything it throws rather than
     * letting the rest of the switch — and the user's operation with it — end
     * mid-way with nothing said.
     *
     * Deliberately does not rethrow: `watchGlobals` would then report the same
     * failure a second time, without the command name this one has.
     */
    whileHandling(command: string, apply: () => void) {
      try {
        apply();
      } catch (error: unknown) {
        // Still leave it in the webview's own console: for a developer with the
        // Webview Developer Tools open, that is the live, clickable stack, and
        // catching here must not take it away from them.
        // eslint-disable-next-line no-console -- the console is the developer's copy of this
        console.error(error);
        report("message", command, error);
      }
    },
    /**
     * Catch what runs outside every other boundary — timer callbacks, promise
     * chains, DOM event handlers — where the message-handling catch cannot
     * reach because the stack that scheduled the work is long gone.
     */
    watchGlobals(target: Window) {
      target.addEventListener("error", (event) => {
        // `error` is absent when the browser withholds the value (a
        // cross-origin script); the message is then all there is.
        report("uncaught", null, event.error ?? event.message);
      });
      target.addEventListener("unhandledrejection", (event) => {
        report("unhandledRejection", null, event.reason);
      });
    }
  };
}
