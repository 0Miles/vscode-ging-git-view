import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A reload that finds the same commits, with only the uncommitted-change count
// moved, skips the redraw and rewrites the uncommitted-changes row in place
// (`renderUncommitedChanges`). That write found its row with a document-wide
// lookup, the last of the graph's to do so after #150 scoped the reads and
// #166 the bindings (#261). So, as in `graphCommitRowReads`, `#dialog` is moved
// ahead of the graph and given a row of the same class: a document-wide lookup
// writes into it, and a scoped one cannot.
//
// The rewrite had drifted from the row `renderTable` draws in two more ways,
// and both are pinned here because they are what the in-place write has to
// reproduce: it dropped the `hidden` class off a hidden column's cell, so the
// row grew a cell its header does not have, and it showed the host's English
// label rather than the localized one the redraw shows.

const LOCALIZED = "未提交的變更 ({0})";

const viewState = makeViewState({
  defaultColumnVisibility: { date: false, author: true, commit: true }
});

function uncommitted(count: number): GitCommitNode {
  return {
    hash: "*",
    parentHashes: ["aaa111"],
    author: "*",
    email: "",
    date: 1700000100,
    message: `Uncommitted Changes (${count})`,
    refs: []
  };
}

const tip: GitCommitNode = {
  hash: "aaa111",
  parentHashes: [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000,
  message: "Tip commit",
  refs: [{ hash: "aaa111", name: "main", type: "head" }]
};

function commitsResponse(count: number, hard: boolean): GG.ResponseMessage {
  return {
    command: "loadCommits",
    token: 0,
    commits: [uncommitted(count), tip],
    head: "aaa111",
    moreCommitsAvailable: false,
    hard
  };
}

const STAND_IN = "Stand-in changes";

function graphUncommittedRow() {
  const row = document.querySelector<HTMLTableRowElement>("#commitTable tr.unsavedChanges");
  expect(row).not.toBeNull();
  return row!;
}

describe("the uncommitted-changes row, rewritten in place by a soft reload", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    (globalThis as unknown as { l10n: { uncommittedChanges: string } }).l10n.uncommittedChanges =
      LOCALIZED;
    document.body.insertBefore(
      document.getElementById("dialog")!,
      document.getElementById("content")!
    );
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
    receive(commitsResponse(2, true));
    document.getElementById("dialog")!.innerHTML =
      '<table><tr class="unsavedChanges"><td>' + STAND_IN + "</td></tr></table>";
    // Same commits, one more change: the soft path.
    receive(commitsResponse(3, false));
  });

  it("writes into the graph's row, not into the dialog's copy ahead of it", () => {
    expect(document.querySelector("#dialog tr.unsavedChanges")!.textContent).toBe(STAND_IN);
    expect(graphUncommittedRow().textContent).toContain("(3)");
  });

  it("keeps a hidden column's cell hidden, as the redraw draws it", () => {
    const cells = Array.from(graphUncommittedRow().cells);
    const headers = Array.from(document.querySelectorAll("#tableColHeaders th"));
    expect(cells.map((c) => c.classList.contains("hidden"))).toEqual(
      headers.map((h) => h.classList.contains("hidden"))
    );
  });

  it("shows the localized label, as the redraw does", () => {
    expect(graphUncommittedRow().textContent).toContain(LOCALIZED.replace("{0}", "3"));
  });
});
