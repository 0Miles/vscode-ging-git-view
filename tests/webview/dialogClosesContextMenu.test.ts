import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A dialog the user did not ask for — an action's error, a batch summary —
// arrives from the host on its own schedule, and can find a context menu open.
// Since #218 the dialog's backing sits above the menu, so a menu left open
// would be stranded under it: unclickable, still `active`, and back on screen
// the moment the dialog closes, offering actions computed before whatever the
// dialog was reporting. The dialog takes the screen, so it closes the menu.

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

const contextMenu = () => document.getElementById("contextMenu")!;
const dialog = () => document.getElementById("dialog")!;

describe("a dialog raised while a context menu is open", () => {
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

  it("closes the menu, which stays closed once the dialog is dismissed", () => {
    document
      .querySelector('#commitTable tr.commit[data-hash="aaa111"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(contextMenu().classList.contains("active")).toBe(true);

    receive({ command: "fetch", status: "fatal: unable to access remote" });
    expect(dialog().classList.contains("active")).toBe(true);
    expect(contextMenu().classList.contains("active")).toBe(false);

    document.getElementById("dialogDismiss")!.click();
    expect(dialog().classList.contains("active")).toBe(false);
    expect(contextMenu().classList.contains("active")).toBe(false);
  });
});
