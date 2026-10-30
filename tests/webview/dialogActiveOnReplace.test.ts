import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { clickItem, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A dialog raised from a row highlights that row with `.dialogActive` for as
// long as the dialog is about it. A dialog the host raises on its own — an
// error, a batch summary — can take the slot before the user answers, and the
// row it took the slot from is then no longer what any dialog is about. The
// highlight has to go with it, or it stays lit until something redraws the row.

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

    receive({ command: "copyToClipboard", type: "Commit Hash", success: false });
    expect(document.getElementById("dialog")!.textContent).toContain(
      L.unableToCopyToClipboard.replace("{0}", L.typeCommitHash)
    );

    expect(row().classList.contains("dialogActive")).toBe(false);
  });
});
