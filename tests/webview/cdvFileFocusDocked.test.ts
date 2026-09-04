import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import {
  createVscodeMock,
  makeViewState,
  NEAR_BOTTOM,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

// Docked to the bottom, the Commit Details View is a fixed panel in <body>
// rather than a row inside the commit table. Nothing about it is inside what
// `renderTable` replaces, so every reach for the file list has to go through
// the document rather than through the table: scope either the read of the
// focused file or the lookup that puts it back to `#commitTable`, and the
// inline suite carries on passing while docked silently stops restoring
// anything.
//
// The teardown runs on a different schedule too — the table is replaced first,
// with the docked panel still standing, and the panel is removed and rebuilt
// through `body.appendChild` a moment later, when the expanded commit is
// re-bound. That makes docked the *more* forgiving of the two about when focus
// is read, so it is the inline suite, not this one, that pins the capture to
// the top of the redraw.
//
// One webview per file (#80): the location is read at boot, so this is its own
// suite rather than a scenario in the inline one.

const viewState = makeViewState({
  loadMoreAutomatically: true,
  commitDetailsViewLocation: "Docked to Bottom"
});

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

const nextPage: GitCommitNode[] = [
  ...commits,
  {
    hash: "ccc333",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1698000000,
    message: "Initial commit",
    refs: []
  }
];

function commitsResponse(loaded: GitCommitNode[]): GG.ResponseMessage {
  return {
    command: "loadCommits",
    token: 0,
    commits: loaded,
    head: "aaa111",
    moreCommitsAvailable: true,
    hard: true
  };
}

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
    { oldFilePath: "src/b.ts", newFilePath: "src/b.ts", type: "M", additions: 2, deletions: 1 },
    { oldFilePath: "README.md", newFilePath: "README.md", type: "M", additions: 3, deletions: 0 }
  ]
};

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function fileRows() {
  return Array.from(document.querySelectorAll<HTMLElement>("#commitDetails .gitFile"));
}

function filePathOf(file: Element | null) {
  return decodeURIComponent((<HTMLElement>file).dataset.newfilepath!);
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("file-list focus with the Commit Details View docked to the bottom", () => {
  let focusedBefore: HTMLElement;
  let focusedAfterLoad: Element | null = null;

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
    receive(commitsResponse(commits));

    row("aaa111").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    receive({ command: "commitDetails", commitDetails: tipDetails });

    focusedBefore = fileRows()[1];
    focusedBefore.focus();

    parkViewportAt(NEAR_BOTTOM);
    document.dispatchEvent(new Event("scroll"));
    receive(commitsResponse(nextPage));
    focusedAfterLoad = document.activeElement;
  });

  it("docks the panel outside the table the redraw replaces", () => {
    const panel = document.getElementById("commitDetails")!;
    expect(panel.classList.contains("docked")).toBe(true);
    expect(panel.closest("#commitTable")).toBeNull();
  });

  it("rebuilds the docked panel, replacing the row that held focus", () => {
    expect(row("ccc333")).not.toBeNull();
    expect(fileRows()).toHaveLength(3);
    expect(fileRows()).not.toContain(focusedBefore);
  });

  it("leaves focus on the same file, in its new row", () => {
    expect(filePathOf(focusedAfterLoad)).toBe("src/b.ts");
    expect(focusedAfterLoad).toBe(fileRows()[1]);
    // The rebuilt panel is a new <div>, so the group's single tab stop has to
    // have been re-established on it rather than left on the detached one.
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('#commitDetails [tabindex="0"]'))
    ).toEqual([fileRows()[1]]);
  });

  it("carries on through the file list rather than dropping into the graph", () => {
    press("ArrowDown");
    expect(document.activeElement).toBe(fileRows()[2]);
  });
});
