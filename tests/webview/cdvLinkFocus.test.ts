import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";

import { createVscodeMock, graphRow, makeViewState, receive, rightClick, setupHtml } from "./setup";

// A link in the Commit Details View's summary — the author's and committer's
// addresses, a URL or an issue in the message — is a real `<a href>`, so Tab
// stops on it. A redraw replaces it like every other element of the panel,
// and only graph rows and file rows were looked up again afterwards: focus on
// a link fell to `<body>`, whether or not a context menu was open on it (#251).
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

const DOCS = "https://example.com/docs";

const tipDetails: GitCommitDetails = {
  hash: "aaa111",
  parents: ["bbb222"],
  author: "Alice",
  email: "alice@example.com",
  committer: "Carol",
  committerEmail: "carol@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  // The same address twice: only its position tells the two links apart.
  body: `Tip commit\n\nSee ${DOCS} and again ${DOCS}`,
  fileChanges: [
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 }
  ]
};

const contextMenu = () => document.getElementById("contextMenu")!;

function links(href: string) {
  return Array.from(
    document.querySelectorAll<HTMLAnchorElement>("#commitDetails .commitBodyLink")
  ).filter((link) => link.getAttribute("href") === href);
}

/** A redraw nothing else follows: a soft reload whose remote names changed. */
let remoteCount = 0;
function redraw() {
  remoteCount++;
  const remotes = Array.from({ length: remoteCount }, (_, i) => "remote" + i);
  receive({ command: "loadRemotes", remotes, pushDefault: null });
}

describe("focus on a link in the Commit Details View across a redraw", () => {
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
    graphRow("aaa111").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    receive({ command: "commitDetails", commitDetails: tipDetails });
    expect(links(DOCS)).toHaveLength(2);
  });

  describe("on the committer's address", () => {
    let source: HTMLAnchorElement;

    beforeAll(() => {
      source = links("mailto:carol%40example.com")[0];
      source.focus();
      redraw();
    });

    it("is a redraw that replaced the link", () => {
      expect(source.isConnected).toBe(false);
    });

    it("puts focus on the same link in the new panel", () => {
      expect(document.activeElement).toBe(links("mailto:carol%40example.com")[0]);
    });
  });

  describe("on the second of two links to the same address", () => {
    beforeAll(() => {
      links(DOCS)[1].focus();
      redraw();
    });

    it("puts focus on the second one again, not the first", () => {
      expect(document.activeElement).toBe(links(DOCS)[1]);
    });
  });

  describe("with a context menu open on it", () => {
    let source: HTMLAnchorElement;

    beforeAll(() => {
      source = links("mailto:alice%40example.com")[0];
      source.focus();
      rightClick(source);
      expect(contextMenu().classList.contains("active")).toBe(true);
      expect(contextMenu().contains(document.activeElement)).toBe(true);
      redraw();
    });

    it("closes the menu", () => {
      expect(contextMenu().classList.contains("active")).toBe(false);
      expect(source.isConnected).toBe(false);
    });

    it("puts focus on the same link in the new panel", () => {
      expect(document.activeElement).toBe(links("mailto:alice%40example.com")[0]);
    });
  });
});
