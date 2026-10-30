import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";

import { createVscodeMock, graphRow, makeViewState, receive, setupHtml } from "./setup";

/* Moving a docked Commit Details View from one commit to another — a click on
 * another row, an arrow key, Find — tears the old panel down and waits for the
 * new commit's details. Tearing it down took `cdvDocked` with it, and with that
 * class the page's bottom padding: the page was a panel's height shorter for
 * the length of the round trip, so a user scrolled to the bottom was clamped
 * up by it, and pushed back when the panel arrived (#256). The panel is about
 * to come back, so the space it takes stays reserved until it does — or until
 * the view is closed for good, which is what an unanswerable request does.
 * One webview per file (#80): the location is read at boot. */

const viewState = makeViewState({ commitDetailsViewLocation: "Docked to Bottom" });

const commits: GitCommitNode[] = ["aaa111", "bbb222", "ccc333"].map((hash, i, all) => ({
  hash,
  parentHashes: i + 1 < all.length ? [all[i + 1]] : [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000 - i,
  message: "Commit " + hash,
  refs: i === 0 ? [{ hash, name: "main", type: "head" }] : []
}));

function details(hash: string): GitCommitDetails {
  return {
    hash,
    parents: [],
    author: "Alice",
    email: "alice@example.com",
    committer: "Alice",
    committerEmail: "alice@example.com",
    authorDate: 1700000000,
    commitDate: 1700000000,
    body: "Body",
    fileChanges: []
  };
}

const docked = () => document.body.classList.contains("cdvDocked");
const panel = () => document.getElementById("commitDetails");

describe("moving a docked Commit Details View to another commit", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
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
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
    graphRow("aaa111").click();
    receive({ command: "commitDetails", commitDetails: details("aaa111") });
    expect(panel()!.classList.contains("docked")).toBe(true);
  });

  describe("while the next commit's details are on their way", () => {
    beforeAll(() => {
      graphRow("bbb222").click();
    });

    it("has taken the old panel down", () => {
      expect(panel()).toBeNull();
    });

    it("keeps the panel's space reserved", () => {
      expect(docked()).toBe(true);
    });

    it("and still has it once they arrive", () => {
      receive({ command: "commitDetails", commitDetails: details("bbb222") });
      expect(panel()!.classList.contains("docked")).toBe(true);
      expect(docked()).toBe(true);
    });
  });

  describe("when the next commit's details cannot be loaded", () => {
    beforeAll(() => {
      graphRow("ccc333").click();
      receive({ command: "commitDetails", commitDetails: null });
    });

    it("gives the space back with the view", () => {
      expect(panel()).toBeNull();
      expect(docked()).toBe(false);
    });
  });
});
