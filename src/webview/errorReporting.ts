import type { ResponseMessage, WebviewErrorReport } from "@/types";

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
 * described and sent to the host, which decides what to do with it (ADR-0016).
 *
 * Nothing here decides whether the failure is logged, repeated or shown to the
 * user — those rules live with the surfaces they govern, on the host. This side
 * describes what happened, in full, every time it happens.
 */
export function createErrorReporter(send: (report: WebviewErrorReport) => void) {
  function report(
    origin: WebviewErrorReport["origin"],
    command: ResponseMessage["command"] | null,
    thrown: unknown
  ) {
    send({ origin, command, ...describeThrown(thrown) });
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
    whileHandling(command: ResponseMessage["command"], apply: () => void) {
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
