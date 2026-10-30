import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A redraw replaces every row of the commit table, and the Commit Details View
// with them. A context menu opened on one of those rows outlived it (#126): it
// stayed at the page coordinates it was opened at, over whatever row the
// redraw put there, still offering Reset and Delete for the old one — and its
// source was now a detached node, so closing it could neither clear the
// highlight nor hand focus back, and focus fell to <body>.
//
// Hard reloads and reloads that change something already close the menu
// (`hideReloadOwnedOverlays`), but only after the redraw has run. A soft reload
// that brings back new remote names redraws from `loadRemotes` and closes
// nothing. So the menu is closed by the redraw itself, before the rows go:
// that is the last moment its source is still in the document to take focus
// back, and from there the redraw's own focus restore carries it over by key.
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
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
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

const tipDetails: GitCommitDetails = {
  hash: "aaa111",
  parents: ["bbb222"],
  author: "Alice",
  email: "alice@example.com",
  committer: "Alice",
  committerEmail: "alice@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  body: "Tip commit",
  fileChanges: [
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 },
    { oldFilePath: "src/b.ts", newFilePath: "src/b.ts", type: "M", additions: 2, deletions: 1 }
  ]
};

const contextMenu = () => document.getElementById("contextMenu")!;

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function fileRow(path: string) {
  return Array.from(document.querySelectorAll<HTMLElement>("#commitDetails .gitFile")).find(
    (file) => decodeURIComponent(file.dataset.newfilepath!) === path
  )!;
}

/** Open the menu the way Shift+F10 does: from the element holding focus, which
 *  the menu then takes over. */
function openMenuOn(source: HTMLElement) {
  source.focus();
  source.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  expect(contextMenu().classList.contains("active")).toBe(true);
  expect(contextMenu().contains(document.activeElement)).toBe(true);
}

/** A soft reload whose remote list differs from the last one: `loadRemotes`
 *  redraws on its own, and nothing after it closes the menu. */
let remoteCount = 0;
function softReloadWithNewRemotes() {
  remoteCount++;
  const remotes = Array.from({ length: remoteCount }, (_, i) => "remote" + i);
  receive({ command: "loadRemotes", remotes, pushDefault: null });
}

describe("a redraw arriving while a context menu is open", () => {
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

  describe("on a commit row", () => {
    let source: HTMLElement;

    beforeAll(() => {
      source = row("bbb222");
      openMenuOn(source);
      softReloadWithNewRemotes();
    });

    it("is a redraw that replaced the row the menu was opened on", () => {
      expect(source.isConnected).toBe(false);
    });

    it("closes the menu, clearing its mark from the source", () => {
      expect(contextMenu().classList.contains("active")).toBe(false);
      expect(contextMenu().innerHTML).toBe("");
      expect(source.classList.contains("contextMenuActive")).toBe(false);
    });

    it("puts focus on the same commit's new row", () => {
      expect(document.activeElement).toBe(row("bbb222"));
    });
  });

  describe("on a file in the Commit Details View", () => {
    let source: HTMLElement;

    beforeAll(() => {
      row("aaa111").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({ command: "commitDetails", commitDetails: tipDetails });
      source = fileRow("src/b.ts");
      openMenuOn(source);
      softReloadWithNewRemotes();
    });

    it("is a redraw that replaced the file the menu was opened on", () => {
      expect(source.isConnected).toBe(false);
    });

    it("closes the menu, clearing its mark from the source", () => {
      expect(contextMenu().classList.contains("active")).toBe(false);
      expect(source.classList.contains("contextMenuActive")).toBe(false);
    });

    it("puts focus on the same file's new row", () => {
      expect(document.activeElement).toBe(fileRow("src/b.ts"));
    });
  });
});
