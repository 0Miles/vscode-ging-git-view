import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as GG from "@/types";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const REPO = DEFAULT_REPO;

const viewState = makeViewState({
  // Global setting is false, but the repo carries a per-repo override of true.
  repos: { [REPO]: { columnWidths: null, showRemoteBranches: true } },
  showRemoteBranches: false
});

describe("showRemoteBranches per-repo override", () => {
  let sentMessages: GG.RequestMessage[];
  beforeAll(async () => {
    vi.resetModules();
    sentMessages = createVscodeMock().sentMessages;
    setupHtml(viewState);
    await import("@/webview/main");
    // Complete the startup handshake: until the initial load lands, the webview
    // holds off any further branch request, and the toggle would look inert for
    // reasons that have nothing to do with what is under test.
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
  });

  // The value no longer travels in the request — the host resolves it. What
  // still has to track the per-repo override is the webview's memo of the value
  // in force: get that wrong and the side-view's toggle either reloads for
  // nothing or, worse, is swallowed as a no-op.
  it("treats the per-repo override as the value in force, not the global setting", () => {
    const before = sentMessages.length;
    receive({ command: "setShowRemoteBranches", value: true });
    // The override already says true, so this announcement changes nothing.
    expect(sentMessages.length).toBe(before);
  });

  it("reloads when told to drop remotes, against that override", () => {
    const before = sentMessages.length;
    receive({ command: "setShowRemoteBranches", value: false });
    expect(sentMessages.slice(before).some((m) => m.command === "loadBranches")).toBe(true);
  });
});
