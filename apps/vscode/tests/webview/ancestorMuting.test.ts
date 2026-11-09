import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState({
  muteCommitsNotAncestorsOfHead: true,
  // Keep merge-commit muting out of the picture so every `.muted` row below
  // is attributable to the ancestor check alone.
  muteMergeCommits: false
});

// HEAD = abc123; side999 is a separate branch tip not reachable from HEAD, so
// it should be muted, while HEAD and its ancestor def456 should not be.
const commits: GitCommitNode[] = [
  {
    hash: "side999",
    parentHashes: ["def456"],
    author: "Carol",
    email: "carol@example.com",
    date: 1700200000,
    message: "Side branch work",
    refs: [{ hash: "side999", name: "feature", type: "head" }]
  },
  {
    hash: "abc123",
    parentHashes: ["def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "On head",
    refs: [{ hash: "abc123", name: "main", type: "head" }]
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

describe("muteCommitsNotAncestorsOfHead", () => {
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

  it("mutes commits that are not ancestors of HEAD", () => {
    expect(
      document.querySelector('.commit[data-hash="side999"]')!.classList.contains("muted")
    ).toBe(true);
  });

  it("does not mute HEAD or its ancestors", () => {
    expect(document.querySelector('.commit[data-hash="abc123"]')!.classList.contains("muted")).toBe(
      false
    );
    expect(document.querySelector('.commit[data-hash="def456"]')!.classList.contains("muted")).toBe(
      false
    );
  });

  it("mutes nothing when HEAD is not within the loaded commits", () => {
    // HEAD points to a commit that isn't loaded: ancestry is unknowable, so no
    // commit should be muted on that basis.
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "notloaded000",
      moreCommitsAvailable: false,
      hard: true
    });
    for (const c of commits) {
      expect(
        document.querySelector(`.commit[data-hash="${c.hash}"]`)!.classList.contains("muted")
      ).toBe(false);
    }
  });
});
