import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { createVscodeMock, graphRow, makeViewState, receive, rightClick, setupHtml } from "./setup";

// Closing a context menu hands focus back to the element it was opened on. A
// local head chip, and the remote badge folded into it, rendered with no
// tabindex, so a menu raised on one by the pointer *lent* it one — and closing
// gave focus back, then took the loan away from the element now holding focus.
// Chromium answers that by dropping focus to `<body>` (#251). jsdom does not,
// so these pin the cause: the chips are focusable on their own, and stay so.
//
// One webview is booted for the whole file and the scenarios run in order; a
// second import would leave the first instance listening on `window` (#80).

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "origin/main", type: "remote" }
    ]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
  }
];

const contextMenu = () => document.getElementById("contextMenu")!;

function headChip() {
  return graphRow("aaa111").querySelector<HTMLElement>(".gitRef.head")!;
}

function remoteBadge() {
  return headChip().querySelector<HTMLElement>(".gitRef.remote.gitRefCombined")!;
}

/** Raise the menu with the pointer — the source is not focused first, which is
 *  the case that used to need the loan — then move into it from the keyboard. */
function openMenuByPointerOn(source: HTMLElement) {
  rightClick(source);
  expect(contextMenu().classList.contains("active")).toBe(true);
  expect(contextMenu().contains(document.activeElement)).toBe(true);
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
}

describe("a context menu raised on a local head chip", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
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
  });

  it("renders the chip and its remote badge focusable", () => {
    expect(headChip().getAttribute("tabindex")).toBe("-1");
    expect(remoteBadge().getAttribute("tabindex")).toBe("-1");
  });

  describe("closed with Escape", () => {
    beforeAll(() => {
      openMenuByPointerOn(headChip());
      pressEscape();
    });

    it("gives focus back to the chip", () => {
      expect(contextMenu().classList.contains("active")).toBe(false);
      expect(document.activeElement).toBe(headChip());
    });

    it("leaves the chip focusable, so focus can stay there", () => {
      expect(headChip().getAttribute("tabindex")).not.toBeNull();
    });
  });

  describe("closed with Escape from the remote badge", () => {
    beforeAll(() => {
      openMenuByPointerOn(remoteBadge());
      pressEscape();
    });

    it("gives focus back to the badge, which stays focusable", () => {
      expect(document.activeElement).toBe(remoteBadge());
      expect(remoteBadge().getAttribute("tabindex")).not.toBeNull();
    });
  });
});
