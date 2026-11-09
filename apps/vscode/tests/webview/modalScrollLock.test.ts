import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { clickId, createVscodeMock, dialogShown, makeViewState, receive, setupHtml } from "./setup";

// A modal dialog holds the page still behind it (#230). The backing already
// takes every click, but the page itself kept scrolling under it: its
// scrollbar sits outside the backing's reach, and the wheel and PageDown/Space
// chained to the document. `<html>` carrying `dialogOpen` is what locks it —
// the declarations that do the locking are main.css's, held by
// `tests/backend/utils/modalScrollLockStyle.test.ts`, since jsdom loads no
// stylesheet. What is pinned here is that the class follows the dialog: on for
// as long as one is up, through one dialog replacing another, and off by every
// route that closes the last.

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  }
];

const locked = () => document.documentElement.classList.contains("dialogOpen");
/** An action's error, which the host raises as a dialog with a Dismiss. */
const raiseError = () => receive({ command: "fetch", status: "fatal: unable to access remote" });

describe("the page behind a modal dialog", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(makeViewState());
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
  });

  it("is not locked while no dialog is up", () => {
    expect(dialogShown()).toBe(false);
    expect(locked()).toBe(false);
  });

  it("is locked while a dialog is up, and unlocked by Dismiss", () => {
    raiseError();
    expect(dialogShown()).toBe(true);
    expect(locked()).toBe(true);

    document.getElementById("dialogDismiss")!.click();
    expect(dialogShown()).toBe(false);
    expect(locked()).toBe(false);
  });

  it("is unlocked by Escape", () => {
    raiseError();
    expect(locked()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    expect(dialogShown()).toBe(false);
    expect(locked()).toBe(false);
  });

  it("stays locked when one dialog replaces another, until the last one closes", () => {
    // The fetch's own progress dialog, replaced by its answer — an error over
    // a dialog of the user's would wait behind it instead (#243).
    clickId("fetchBtn");
    expect(document.getElementById("actionRunning")).not.toBeNull();
    raiseError();
    expect(document.getElementById("actionRunning")).toBeNull();
    expect(locked()).toBe(true);

    document.getElementById("dialogDismiss")!.click();
    expect(locked()).toBe(false);
  });
});
