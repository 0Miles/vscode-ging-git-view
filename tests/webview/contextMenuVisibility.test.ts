import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { mergeContextMenuActionsVisibility } from "@/backend/utils/contextMenuVisibility";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// Hide a couple of commit-menu actions; everything else stays visible.
const viewState = makeViewState({
  contextMenuActionsVisibility: mergeContextMenuActionsVisibility({
    commit: { addTag: false, drop: false }
  })
});

const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: ["def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: []
  },
  {
    hash: "def456",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Initial commit",
    refs: []
  }
];

describe("contextMenuActionsVisibility gating", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "abc123",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("omits commit actions whose visibility is set to false", () => {
    const row = document.querySelector<HTMLElement>('tr.commit[data-hash="abc123"]')!;
    expect(row).not.toBeNull();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const menuText = document.getElementById("contextMenu")!.textContent ?? "";
    // Hidden actions are absent...
    expect(menuText).not.toContain("Add Tag");
    expect(menuText).not.toContain("Drop");
    // ...while non-hidden actions remain.
    expect(menuText).toContain("Create Branch");
    expect(menuText).toContain("Merge");
  });
});
