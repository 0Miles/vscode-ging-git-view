import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState({ showRemoteBranches: false });

describe("showRemoteBranches default", () => {
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
      token: 0,
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
  });

  // The toggle lives in the Branches side-view and the host resolves the
  // repo's state for every query, so the request carries no copy of it
  // (ADR-0013). What the webview still tracks is whether it has already
  // applied a given value — that memo is what keeps a redundant announcement
  // from costing a full reload.
  it("requests branches without echoing a showRemoteBranches of its own", () => {
    const msg = sentMessages.find((m) => m.command === "loadBranches") as
      | Extract<GG.RequestMessage, { command: "loadBranches" }>
      | undefined;
    expect(msg).toBeDefined();
    expect(msg).not.toHaveProperty("showRemoteBranches");
  });

  it("ignores an announcement matching the global setting it already holds", () => {
    const before = sentMessages.length;
    receive({ command: "setShowRemoteBranches", value: false });
    expect(sentMessages.length).toBe(before);
  });

  it("reloads when the announced value actually differs", () => {
    const before = sentMessages.length;
    receive({ command: "setShowRemoteBranches", value: true });
    expect(sentMessages.slice(before).some((m) => m.command === "loadBranches")).toBe(true);
  });
});
