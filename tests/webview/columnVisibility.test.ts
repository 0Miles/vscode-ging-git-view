import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState({
  defaultColumnVisibility: { date: false, author: true, commit: true }
});

const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Only commit",
    refs: [{ hash: "abc123", name: "main", type: "head" }]
  }
];

describe("defaultColumnVisibility", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      commits,
      head: "abc123",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("hides the Date column header and cells when configured invisible", () => {
    const dateHeader = document.querySelector('th[data-col="date"]');
    expect(dateHeader).not.toBeNull();
    expect(dateHeader!.classList.contains("hidden")).toBe(true);
  });

  it("keeps the Author and Commit columns visible", () => {
    expect(document.querySelector('th[data-col="author"]')!.classList.contains("hidden")).toBe(
      false
    );
    expect(document.querySelector('th[data-col="commit"]')!.classList.contains("hidden")).toBe(
      false
    );
  });
});
