import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState({ onLoadScrollToHead: true });

const commits: GitCommitNode[] = [
  {
    hash: "head111",
    parentHashes: ["base222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Head commit",
    refs: [{ hash: "head111", name: "main", type: "head" }]
  },
  {
    hash: "base222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Initial commit",
    refs: []
  }
];

describe("onLoad.scrollToHead", () => {
  const scrollSpy = vi.fn();

  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    // jsdom doesn't implement scrollIntoView; provide a spy so scrollToHead runs.
    Element.prototype.scrollIntoView = scrollSpy;
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
      head: "head111",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("scrolls the HEAD row into view on the first load", () => {
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("does not scroll again on a subsequent load", () => {
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "head111",
      moreCommitsAvailable: false,
      hard: true
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });
});
