import { describe, expect, it } from "vitest";

import { createWebviewErrorSink } from "@/extension/webviewErrorSink";
import type { WebviewErrorReport } from "@/types";

const report = (over: Partial<WebviewErrorReport> = {}): WebviewErrorReport => ({
  origin: "message",
  command: "showBranchCleanup",
  message: "ReferenceError: groupToggleState is not defined",
  stack: "ReferenceError: groupToggleState is not defined\n    at syncCleanupGroupToggles",
  ...over
});

function makeSink() {
  const lines: string[] = [];
  // Notifications are held open until the test closes them, the way a VSCode
  // error notification stays up until the user deals with it.
  const open: (() => void)[] = [];
  const sink = createWebviewErrorSink({
    log: (line) => lines.push(line),
    notify: () => new Promise<void>((resolve) => open.push(resolve))
  });
  return {
    sink,
    lines,
    notifications: () => open.length,
    /** Dismiss every notification on screen and let the sink observe it. */
    dismissAll: async () => {
      open.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
    }
  };
}

describe("webview failures reaching the log (issue #39)", () => {
  it("names the message that failed, and keeps the whole stack", () => {
    // This channel is the only place a webview failure is written down, so a
    // bug report is assembled from exactly what lands here.
    const { sink, lines } = makeSink();
    sink(report());

    expect(lines[0]).toContain('while handling "showBranchCleanup"');
    expect(lines[0]).toContain("at syncCleanupGroupToggles");
  });

  it("says the message once, not twice, when the stack already opens with it", () => {
    const { sink, lines } = makeSink();
    sink(report());

    expect(lines[0]!.match(/groupToggleState is not defined/g)).toHaveLength(1);
  });

  it("falls back to the message when what was thrown carried no stack", () => {
    const { sink, lines } = makeSink();
    sink(report({ stack: null, message: "boom" }));

    expect(lines[0]).toContain("boom");
  });

  it("distinguishes the two catch-alls, which name no message", () => {
    const { sink, lines } = makeSink();
    sink(report({ origin: "uncaught", command: null, stack: null }));
    sink(report({ origin: "unhandledRejection", command: null, stack: null }));

    expect(lines[0]).toContain("webview uncaught:");
    expect(lines[1]).toContain("webview unhandled rejection:");
  });

  it("writes an identical failure once, however often it repeats", () => {
    // A failure inside a render loop repeats as fast as the event does, and the
    // git commands around it must survive that.
    const { sink, lines } = makeSink();
    sink(report());
    sink(report());
    sink(report());

    expect(lines).toHaveLength(1);
  });

  it("writes a failure that differs only in its stack", () => {
    const { sink, lines } = makeSink();
    sink(report());
    sink(report({ stack: "ReferenceError: groupToggleState is not defined\n    at elsewhere" }));

    expect(lines).toHaveLength(2);
  });
});

describe("webview failures reaching the user (issue #39)", () => {
  it("tells the user something did not finish", async () => {
    const { sink, notifications } = makeSink();
    sink(report());

    expect(notifications()).toBe(1);
  });

  it("tells them about the catch-alls too", async () => {
    // A click handler that throws lands in `uncaught`, and a click is as
    // user-triggered as anything gets.
    const { sink, notifications } = makeSink();
    sink(report({ origin: "uncaught", command: null }));

    expect(notifications()).toBe(1);
  });

  it("does not stack a second notification on an unanswered one", async () => {
    const { sink, notifications } = makeSink();
    sink(report());
    sink(report({ message: "TypeError: something else", stack: null }));

    expect(notifications()).toBe(1);
  });

  it("tells them again once the last one has been dealt with", async () => {
    // Repetition is not suppressed here the way it is in the log: every
    // occurrence is a fresh operation that did not finish.
    const { sink, notifications, dismissAll } = makeSink();
    sink(report());
    await dismissAll();
    sink(report());

    expect(notifications()).toBe(1);
  });
});
