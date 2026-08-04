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
    expect(run.onResults(results)).toEqual({ kind: "summarise", results });
    // The run is over: the next batch may start.
    expect(run.start(["feature-c"], {})).toEqual({ kind: "send", refs: ["feature-c"], round: 1 });
  });

  it("refuses a second batch while one is in flight", () => {
    const run = new BatchRun();
    run.start(["feature-a"], {});
    expect(run.start(["feature-b"], {})).toEqual({ kind: "busy" });
    // The refused start must not disturb the run in flight.
    const results = [{ ref: "feature-a", status: null }];
    expect(run.onResults(results)).toEqual({ kind: "summarise", results });
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
      ]
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
    expect(run.onRetryDeclined()).toEqual({ kind: "summarise", results: round1 });
    expect(run.start(["c"], {})).toEqual({ kind: "send", refs: ["c"], round: 1 });
  });

  it("summarises without a retry offer when the predicate matches nothing", () => {
    const run = new BatchRun();
    run.start(["a", "b"], { retryWhen: (r) => r.status === "error: not fully merged" });
    const results = [
      { ref: "a", status: null },
      { ref: "b", status: "error: some other failure" }
    ];
    expect(run.onResults(results)).toEqual({ kind: "summarise", results });
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
    expect(run.onResults(results, "pushBranches")).toEqual({ kind: "summarise", results });
  });

  it("stays busy through the retry offer and the retry round", () => {
    const run = new BatchRun();
    run.start(["a"], { retryWhen: () => true });
    run.onResults([{ ref: "a", status: "error: not fully merged" }]);
    // A retry is on offer: still one run in flight.
    expect(run.start(["b"], {})).toEqual({ kind: "busy" });
    run.onRetryConfirmed();
    // The retry round is in flight: still busy.
    expect(run.start(["b"], {})).toEqual({ kind: "busy" });
  });

  it("ignores events that do not belong to the state it is in", () => {
    const run = new BatchRun();
    // No run in flight: a stray response is not ours.
    expect(run.onResults([{ ref: "a", status: null }])).toEqual({ kind: "none" });
    // No retry on offer: confirmations have nothing to confirm.
    expect(run.onRetryConfirmed()).toEqual({ kind: "none" });
    expect(run.onRetryDeclined()).toEqual({ kind: "none" });
    // While a retry is on offer, results are not expected either.
    run.start(["a"], { retryWhen: () => true });
    run.onResults([{ ref: "a", status: "error: not fully merged" }]);
    expect(run.onResults([{ ref: "a", status: null }])).toEqual({ kind: "none" });
  });
});
