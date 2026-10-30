import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import {
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  makeViewState,
  receive,
  setupHtml
} from "./setup";

// A dialog raised from a row highlights that row with `.dialogActive` for as
// long as the dialog is about it. A dialog the host raises on its own can take
// the slot before the user answers, and the row it took the slot from is then
// no longer what any dialog is about. The highlight has to go with it, or it
// stays lit until something redraws the row.
//
// The dialog that takes the slot is a delegated action's: an error or a batch
// summary arriving over the user's dialog now waits behind it instead (#243),
// and the side view's request is the one that still takes the slot by design.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

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

const row = () =>
  document.querySelector<HTMLElement>('#commitTable tr.commit[data-hash="aaa111"]')!;

describe("a dialog replaced by another before it was answered", () => {
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

  it("takes the highlight off the row the replaced dialog was about", () => {
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    clickItem(L.addTag + E);
    expect(row().classList.contains("dialogActive"), "the dialog never marked its row").toBe(true);

    receive({ command: "runRefAction", repo: DEFAULT_REPO, ref: "main", action: "rename", seq: 1 });
    expect(document.getElementById("dialog")!.textContent).toContain(L.renameBranch);

    expect(row().classList.contains("dialogActive")).toBe(false);
  });
});
