import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as GG from "@ging/shared/types";

import { createVscodeMock, graphRow, makeViewState, receive, setupHtml } from "./setup";

// The desktop entry (#384) is the bundle only the desktop host ships. What it
// owes the desktop host today is two things: the same graph view the VS Code
// entry boots, and a marker that says which entry the page loaded — the string
// #386's E2E looks for. Keeping it out of the extension's bundle is not this
// file's job: apps/vscode/tests/backend/webviewEntries.test.ts bundles both
// entries itself and holds the extension's to that.
//
// One webview is booted for the whole file, as in busyLoads: re-importing per
// scenario would leave the previous instance listening on `window`.

const viewState = makeViewState();

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits: [
    {
      hash: "aaa111",
      parentHashes: [],
      author: "Alice",
      email: "alice@example.com",
      date: 1700000000,
      message: "Only commit",
      refs: [{ hash: "aaa111", name: "main", type: "head" }]
    }
  ],
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

describe("the desktop entry", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    // As the desktop host serves a graph page (#388).
    document.documentElement.dataset.gingPage = "graph";
    await import("@ging/webview/desktop/main");
  });

  it("marks the page as loaded from the desktop entry", () => {
    expect(document.documentElement.dataset.gingEntry).toBe("ging-desktop-entry");
  });

  it("boots the same graph view the VS Code entry does", () => {
    expect(mock.sentOf("loadBranches")).toHaveLength(1);

    receive(branchesResponse);
    receive(commitsResponse);

    expect(graphRow("aaa111").textContent).toContain("Only commit");
  });

  it("leaves a message that is not the graph's alone, without reporting a failure", () => {
    // The desktop host's own messages (`HostPromptMessage`, #390) travel the
    // same `message` channel but are kept out of `ResponseMessage` (ADR-0031),
    // so the graph's listener hears them too. That is only safe while the
    // dispatch drops a command it has no arm for; this pins it.
    mock.clearMessages();

    receive({ command: "hostPrompt" } as unknown as GG.ResponseMessage);

    expect(mock.sentOf("reportError")).toEqual([]);
  });
});
