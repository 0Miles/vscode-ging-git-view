import type { BatchRefResult } from "@/backend/types";

/** What a batch run tells its adapter to do next. `send` carries the round so
 *  the adapter can decide action-specific parameters (delete forces round 2)
 *  and echoes the `params` given to `start`, so no adapter state has to
 *  survive between rounds.
 *
 *  `summarise` carries the action its run was started for. The other commands
 *  do not need to: each is returned to a caller that had the action in hand to
 *  begin with. A summary is the exception, because {@link BatchRun.abandon} is
 *  called by whatever destroyed the retry offer's dialog, and that caller has
 *  no idea what was in it. Tagging the command is what lets the adapter render
 *  the summary without keeping a copy of the run's action beside the run — a
 *  copy nothing would keep honest. */
export type BatchRunCommand<TAction extends string = string> =
  | { kind: "send"; refs: string[]; round: 1 | 2; params: unknown }
  | { kind: "busy" }
  | { kind: "offerRetry"; refs: string[] }
  | { kind: "summarise"; results: BatchRefResult[]; action: TAction | null }
  | { kind: "none" };

export interface BatchRunOptions<TAction extends string = string> {
  /** Which batch action this run belongs to. Results tagged with a different
   *  action are not ours and are ignored. */
  action?: TAction;
  /** Marks a result as refused in a way one retry round can fix. Absent for
   *  actions with no retry round (push, fast-forward). */
  retryWhen?: (result: BatchRefResult) => boolean;
  /** Echoed verbatim on every `send` this run emits. */
  params?: unknown;
}

/** A batch run: one batch action's execution from the moment the user has
 *  confirmed it, through at most one retry round, to its summary.
 *
 *  At most one run is in flight, and a second is refused explicitly rather than
 *  silently — with one exception: a run left sitting on a retry offer whose
 *  dialog is gone, which {@link start} reads as a run already over rather than
 *  refusing every batch for the life of the panel.
 *
 *  A run has three endings, and all three report what it did: the results land
 *  ({@link onResults}), the user declines the retry round
 *  ({@link onRetryDeclined}), or the offer is taken off the screen before it
 *  can be answered ({@link abandon}). */
export class BatchRun<TAction extends string = string> {
  private state: "idle" | "awaitingRound1" | "offeringRetry" | "awaitingRound2" = "idle";
  private action: TAction | null = null;
  private retryWhen: ((result: BatchRefResult) => boolean) | null = null;
  private params: unknown = undefined;
  private round1: BatchRefResult[] = [];
  private retryRefs: string[] = [];

  /** Begin a run, unless one is genuinely still going.
   *
   *  The two `awaiting` states are waiting on the host and their answer is
   *  still coming, so a second batch is refused there as it always was. A
   *  standing `offeringRetry` is not that: it waits on a dialog, and a dialog
   *  can be taken away without the run ever hearing of it. {@link abandon} is
   *  the hook for that, but it has to be reached on every route that destroys a
   *  dialog and there are at least eight of them — one omission and the run
   *  holds the only slot for the life of the panel, refusing every later batch.
   *  So reaching here in `offeringRetry` is read as an offer nobody answered
   *  and nobody abandoned, and the run behind it as over. This is the backstop
   *  that cannot be forgotten, not the primary fix.
   *
   *  What it costs is round 1's results: a start returns one command and that
   *  command has to be the new run's, so there is nowhere to report them. That
   *  is the whole reason {@link abandon} exists as well — the route that knows
   *  the offer is gone can still say what round 1 did.
   *
   *  What this cannot tell apart is an offer that was destroyed from one still
   *  *on screen*, and a run whose question the user can still answer has not
   *  been abandoned. That distinction is the adapter's to make, and in this
   *  webview it is made for free: every batch start sits behind a question of
   *  its own, and asking it is what takes the standing offer away. See
   *  `startBatchRun` in `main.ts`. */
  start(refs: string[], options: BatchRunOptions<TAction>): BatchRunCommand<TAction> {
    if (this.state !== "idle" && this.state !== "offeringRetry") return { kind: "busy" };
    this.state = "awaitingRound1";
    this.action = options.action ?? null;
    this.retryWhen = options.retryWhen ?? null;
    this.params = options.params;
    return { kind: "send", refs, round: 1, params: this.params };
  }

  onResults(results: BatchRefResult[], action?: string): BatchRunCommand<TAction> {
    if (this.state !== "awaitingRound1" && this.state !== "awaitingRound2") {
      return { kind: "none" }; // not ours (or already summarised)
    }
    if (this.action !== null && action !== undefined && action !== this.action) {
      return { kind: "none" }; // another action's results
    }
    if (this.state === "awaitingRound1" && this.retryWhen !== null) {
      const retryable = results.filter(this.retryWhen).map((r) => r.ref);
      if (retryable.length > 0) {
        this.state = "offeringRetry";
        this.round1 = results;
        this.retryRefs = retryable;
        return { kind: "offerRetry", refs: retryable };
      }
    }
    // The retry round only covers the refs it retried, so fold it back into
    // round 1's results to keep every ref — and the original order.
    const retried = new Map(results.map((r) => [r.ref, r]));
    const summary =
      this.state === "awaitingRound2" ? this.round1.map((r) => retried.get(r.ref) ?? r) : results;
    this.state = "idle";
    return { kind: "summarise", results: summary, action: this.action };
  }

  onRetryConfirmed(): BatchRunCommand<TAction> {
    if (this.state !== "offeringRetry") return { kind: "none" };
    this.state = "awaitingRound2";
    return { kind: "send", refs: this.retryRefs, round: 2, params: this.params };
  }

  /** The user answered the retry offer, and the answer was no. */
  onRetryDeclined(): BatchRunCommand<TAction> {
    return this.endOnRound1();
  }

  /** End the run whose retry offer is gone from the screen without either
   *  answer having been given.
   *
   *  `offeringRetry` is the one busy state that waits on a dialog rather than
   *  on the host, and the webview's dialog is a single slot that anything may
   *  write over. Confirmed and declined are its only other exits, so an offer
   *  that is overwritten strands the run here for the life of the panel, and
   *  every later batch is refused as `busy`.
   *
   *  Only `offeringRetry` is abandonable. The two waiting states are waiting on
   *  the host, whose answer is still coming, and a dialog taken away from them
   *  costs nothing — `onResults` still lands. Returning `none` everywhere else
   *  also makes this safe to call twice, which the caller relies on. */
  abandon(): BatchRunCommand<TAction> {
    return this.endOnRound1();
  }

  /** The two endings that report round 1 and nothing after it: the user said
   *  no, and the question was taken away before they could say anything. The
   *  run cannot tell those apart and should not try — the work behind them is
   *  identical, and so is what is owed to the user for it. They stay separate
   *  entry points because what they *mean* differs, and a caller writing
   *  `abandon()` at a dialog-destruction site should not have to know that
   *  declining is what it turns into. */
  private endOnRound1(): BatchRunCommand<TAction> {
    if (this.state !== "offeringRetry") return { kind: "none" };
    this.state = "idle";
    return { kind: "summarise", results: this.round1, action: this.action };
  }
}
