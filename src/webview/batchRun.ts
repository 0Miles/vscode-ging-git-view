import type { BatchRefResult } from "@/backend/types";

/** What a batch run tells its adapter to do next. `send` carries the round so
 *  the adapter can decide action-specific parameters (delete forces round 2)
 *  and echoes the `params` given to `start`, so no adapter state has to
 *  survive between rounds. */
export type BatchRunCommand =
  | { kind: "send"; refs: string[]; round: 1 | 2; params: unknown }
  | { kind: "busy" }
  | { kind: "offerRetry"; refs: string[] }
  | { kind: "summarise"; results: BatchRefResult[] }
  | { kind: "none" };

export interface BatchRunOptions {
  /** Which batch action this run belongs to. Results tagged with a different
   *  action are not ours and are ignored. */
  action?: string;
  /** Marks a result as refused in a way one retry round can fix. Absent for
   *  actions with no retry round (push, fast-forward). */
  retryWhen?: (result: BatchRefResult) => boolean;
  /** Echoed verbatim on every `send` this run emits. */
  params?: unknown;
}

/** A batch run: one batch action's execution from the moment the user has
 *  confirmed it, through at most one retry round, to its summary. At most one
 *  run is in flight; starting another is refused explicitly, never silently. */
export class BatchRun {
  private state: "idle" | "awaitingRound1" | "offeringRetry" | "awaitingRound2" = "idle";
  private action: string | null = null;
  private retryWhen: ((result: BatchRefResult) => boolean) | null = null;
  private params: unknown = undefined;
  private round1: BatchRefResult[] = [];
  private retryRefs: string[] = [];

  start(refs: string[], options: BatchRunOptions): BatchRunCommand {
    if (this.state !== "idle") return { kind: "busy" };
    this.state = "awaitingRound1";
    this.action = options.action ?? null;
    this.retryWhen = options.retryWhen ?? null;
    this.params = options.params;
    return { kind: "send", refs, round: 1, params: this.params };
  }

  onResults(results: BatchRefResult[], action?: string): BatchRunCommand {
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
    return { kind: "summarise", results: summary };
  }

  onRetryConfirmed(): BatchRunCommand {
    if (this.state !== "offeringRetry") return { kind: "none" };
    this.state = "awaitingRound2";
    return { kind: "send", refs: this.retryRefs, round: 2, params: this.params };
  }

  onRetryDeclined(): BatchRunCommand {
    if (this.state !== "offeringRetry") return { kind: "none" };
    this.state = "idle";
    return { kind: "summarise", results: this.round1 };
  }
}
