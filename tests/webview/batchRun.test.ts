import { describe, expect, it } from "vitest";

import { BatchRun } from "@/webview/batchRun";

describe("BatchRun", () => {
  it("starts an idle run by sending round 1 to the whole target set", () => {
    const run = new BatchRun();
    const command = run.start(["feature-a", "feature-b"], {});
    expect(command).toEqual({ kind: "send", refs: ["feature-a", "feature-b"], round: 1 });
  });

  it("summarises straight away when the action has no retry round", () => {
    const run = new BatchRun();
    run.start(["feature-a", "feature-b"], {});
    const results = [
      { ref: "feature-a", status: null },
      { ref: "feature-b", status: "error: some failure" }
    ];
    expect(run.onResults(results)).toEqual({ kind: "summarise", results, action: null });
    // The run is over: the next batch may start.
    expect(run.start(["feature-c"], {})).toEqual({ kind: "send", refs: ["feature-c"], round: 1 });
  });

  it("refuses a second batch while one is in flight", () => {
    const run = new BatchRun();
    run.start(["feature-a"], {});
    expect(run.start(["feature-b"], {})).toEqual({ kind: "busy" });
    // The refused start must not disturb the run in flight.
    const results = [{ ref: "feature-a", status: null }];
    expect(run.onResults(results)).toEqual({ kind: "summarise", results, action: null });
  });

  it("offers one retry round for the refs the retry predicate matches", () => {
    const run = new BatchRun();
    run.start(["a", "b", "c"], { retryWhen: (r) => r.status === "error: not fully merged" });
    const command = run.onResults([
      { ref: "a", status: null },
      { ref: "b", status: "error: not fully merged" },
      { ref: "c", status: "error: not fully merged" }
    ]);
    expect(command).toEqual({ kind: "offerRetry", refs: ["b", "c"] });
  });

  it("sends round 2 to the retried refs and folds it back in original order", () => {
    const run = new BatchRun();
    run.start(["a", "b", "c"], { retryWhen: (r) => r.status === "error: not fully merged" });
    run.onResults([
      { ref: "a", status: null },
      { ref: "b", status: "error: not fully merged" },
      { ref: "c", status: "error: not fully merged" }
    ]);
    expect(run.onRetryConfirmed()).toEqual({ kind: "send", refs: ["b", "c"], round: 2 });
    // Round 2: b succeeded, c failed again — even in a retryable way, there is
    // no second retry round. The summary covers every ref, in the original
    // order, with the retried refs' results replacing round 1's.
    const command = run.onResults([
      { ref: "c", status: "error: not fully merged" },
      { ref: "b", status: null }
    ]);
    expect(command).toEqual({
      kind: "summarise",
      results: [
        { ref: "a", status: null },
        { ref: "b", status: null },
        { ref: "c", status: "error: not fully merged" }
      ],
      action: null
    });
  });

  it("still summarises round 1 when the retry round is declined", () => {
    const run = new BatchRun();
    run.start(["a", "b"], { retryWhen: (r) => r.status === "error: not fully merged" });
    const round1 = [
      { ref: "a", status: null },
      { ref: "b", status: "error: not fully merged" }
    ];
    run.onResults(round1);
    // Declining the retry still ends a batch that did real work: report what
    // round 1 managed rather than closing in silence.
    expect(run.onRetryDeclined()).toEqual({ kind: "summarise", results: round1, action: null });
    expect(run.start(["c"], {})).toEqual({ kind: "send", refs: ["c"], round: 1 });
  });

  it("summarises without a retry offer when the predicate matches nothing", () => {
    const run = new BatchRun();
    run.start(["a", "b"], { retryWhen: (r) => r.status === "error: not fully merged" });
    const results = [
      { ref: "a", status: null },
      { ref: "b", status: "error: some other failure" }
    ];
    expect(run.onResults(results)).toEqual({ kind: "summarise", results, action: null });
  });

  it("echoes the start params on every send, so no adapter state spans rounds", () => {
    const run = new BatchRun();
    const params = { forceDelete: false, deleteOnRemotes: true };
    expect(run.start(["a"], { retryWhen: () => true, params })).toMatchObject({
      kind: "send",
      round: 1,
      params
    });
    run.onResults([{ ref: "a", status: "error: not fully merged" }]);
    expect(run.onRetryConfirmed()).toMatchObject({ kind: "send", round: 2, params });
  });

  it("ignores results tagged with a different action than the run in flight", () => {
    const run = new BatchRun();
    run.start(["a"], { action: "pushBranches" });
    expect(run.onResults([{ ref: "a", status: null }], "deleteBranches")).toEqual({
      kind: "none"
    });
    const results = [{ ref: "a", status: null }];
    expect(run.onResults(results, "pushBranches")).toEqual({
      kind: "summarise",
      results,
      action: "pushBranches"
    });
  });

  it("stays busy through both rounds, which wait on the host rather than a dialog", () => {
    const run = new BatchRun();
    run.start(["a"], { retryWhen: () => true });
    // Round 1 is in flight: its answer is still coming, so a second batch is
    // refused. (The retry *offer* is not covered here — it waits on a dialog,
    // and the test above says what happens when that dialog is gone.)
    expect(run.start(["b"], {})).toEqual({ kind: "busy" });
    run.onResults([{ ref: "a", status: "error: not fully merged" }]);
    run.onRetryConfirmed();
    // The retry round is in flight: still busy, for the same reason.
    expect(run.start(["b"], {})).toEqual({ kind: "busy" });
  });

  it("reports round 1 when the retry offer is abandoned rather than answered", () => {
    const run = new BatchRun();
    run.start(["a", "b"], { retryWhen: (r) => r.status === "error: not fully merged" });
    const round1 = [
      { ref: "a", status: null },
      { ref: "b", status: "error: not fully merged" }
    ];
    run.onResults(round1);
    // The offer's dialog was taken away before it could be answered. That ends
    // a batch that did real work, so it reports the same summary declining
    // would have — the work is the same either way, only the exit differs.
    expect(run.abandon()).toEqual({ kind: "summarise", results: round1, action: null });
    // And the slot is free again: the next batch is not refused.
    expect(run.start(["c"], {})).toEqual({ kind: "send", refs: ["c"], round: 1 });
  });

  it("lets a new batch through when an unanswered retry offer is all that stands", () => {
    const run = new BatchRun();
    run.start(["a", "b"], { retryWhen: (r) => r.status === "error: not fully merged" });
    run.onResults([
      { ref: "a", status: null },
      { ref: "b", status: "error: not fully merged" }
    ]);
    // The backstop for the offer whose dialog went without anyone abandoning
    // the run: nobody can answer an offer that is no longer on screen, so the
    // run behind it is over. Refusing here is what strands the batch feature
    // for the life of the panel.
    expect(run.start(["c"], {})).toEqual({ kind: "send", refs: ["c"], round: 1 });
  });

  it("ignores events that do not belong to the state it is in", () => {
    const run = new BatchRun();
    // No run in flight: a stray response is not ours.
    expect(run.onResults([{ ref: "a", status: null }])).toEqual({ kind: "none" });
    // No retry on offer: confirmations have nothing to confirm, and there is
    // no offer to abandon either.
    expect(run.onRetryConfirmed()).toEqual({ kind: "none" });
    expect(run.onRetryDeclined()).toEqual({ kind: "none" });
    expect(run.abandon()).toEqual({ kind: "none" });
    // While a retry is on offer, results are not expected either.
    run.start(["a"], { retryWhen: () => true });
    run.onResults([{ ref: "a", status: "error: not fully merged" }]);
    expect(run.onResults([{ ref: "a", status: null }])).toEqual({ kind: "none" });
    // Abandoning twice is not two abandonments: reporting the first summary is
    // itself what raises a dialog, and raising a dialog is what asks a standing
    // offer to be abandoned.
    run.abandon();
    expect(run.abandon()).toEqual({ kind: "none" });
  });

  it("leaves a round waiting on the host alone — its answer is still coming", () => {
    const run = new BatchRun();
    run.start(["a"], { retryWhen: () => true });
    // Round 1 has no dialog to lose; abandoning is only ever about the offer.
    expect(run.abandon()).toEqual({ kind: "none" });
    expect(run.onResults([{ ref: "a", status: "error: not fully merged" }])).toEqual({
      kind: "offerRetry",
      refs: ["a"]
    });
    run.onRetryConfirmed();
    // Nor has the retry round: it is waiting on the host too.
    expect(run.abandon()).toEqual({ kind: "none" });
    expect(run.onResults([{ ref: "a", status: null }])).toEqual({
      kind: "summarise",
      results: [{ ref: "a", status: null }],
      action: null
    });
  });

  it("tags the summary with the action, the one thing an abandoning caller lacks", () => {
    const run = new BatchRun();
    run.start(["a"], { action: "deleteBranches", retryWhen: () => true });
    const round1 = [{ ref: "a", status: "error: not fully merged" }];
    run.onResults(round1, "deleteBranches");
    // Whatever destroyed the offer's dialog knows nothing about what was in it,
    // so the run says which action the summary belongs to rather than making
    // the adapter keep a copy of that beside it.
    expect(run.abandon()).toEqual({
      kind: "summarise",
      results: round1,
      action: "deleteBranches"
    });
  });
});
