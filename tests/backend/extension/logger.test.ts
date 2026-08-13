import { describe, expect, it, vi } from "vitest";

import { createLogger } from "@/extension/logger";
import type { WebviewErrorReport } from "@/types";

// `vi.mock` is hoisted above the imports, so the logger's `import "vscode"`
// resolves to this stub even though the mock is declared after it.
vi.mock("vscode", () => ({}));

function makeLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    appendLine: (line: string) => lines.push(line),
    show: vi.fn()
  } as never);
  return { logger, lines, written: () => lines.join("\n") };
}

const report = (over: Partial<WebviewErrorReport> = {}): WebviewErrorReport => ({
  origin: "message",
  command: "showBranchCleanup",
  message: "ReferenceError: groupToggleState is not defined",
  stack: "ReferenceError: groupToggleState is not defined\n    at syncCleanupGroupToggles",
  ...over
});

describe("webview failures in the Output Channel (issue #39)", () => {
  it("names the message that failed, and keeps the whole stack", () => {
    // This channel is the only place a webview failure is written down, so a
    // bug report is assembled from exactly what lands here.
    const { logger, written } = makeLogger();
    logger.logWebviewError(report());

    expect(written()).toContain('while handling "showBranchCleanup"');
    expect(written()).toContain("at syncCleanupGroupToggles");
    expect(written()).toContain("ERROR:");
  });

  it("says the message once, not twice, when the stack already opens with it", () => {
    const { logger, written } = makeLogger();
    logger.logWebviewError(report());

    expect(written().match(/groupToggleState is not defined/g)).toHaveLength(1);
  });

  it("falls back to the message when what was thrown carried no stack", () => {
    const { logger, written } = makeLogger();
    logger.logWebviewError(report({ stack: null, message: "boom" }));

    expect(written()).toContain("boom");
  });

  it("distinguishes the two catch-alls, which name no message", () => {
    const { logger, lines } = makeLogger();
    logger.logWebviewError(report({ origin: "uncaught", command: null, stack: null }));
    logger.logWebviewError(report({ origin: "unhandledRejection", command: null, stack: null }));

    expect(lines[0]).toContain("webview uncaught:");
    expect(lines[1]).toContain("webview unhandled rejection:");
  });
});
