import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode, GitFileChange } from "@/backend/types";
import type * as GG from "@/types";

import {
  createVscodeMock,
  makeViewState,
  NEAR_BOTTOM,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

// Where Tab re-enters the Commit Details View's file list after a redraw (#129).
// `cdvFileFocus.test.ts` covers the case where focus is *in* the list when the
// redraw lands; this one is the other case — focus is elsewhere, and all that
// is left of the user's place is the list's tab stop. A redraw replaces every
// row, so the element that held it is gone, and without remembering *which
// file* it was the stop fell back to the first row every time.
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session actually unfolds (#80).

const viewState = makeViewState({ loadMoreAutomatically: true, fileTreeCompactFolders: false });

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

/** What the next page brings back: strictly appended, so the expanded commit
 *  and every file in it is still here, under brand new elements. */
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

function change(path: string): GitFileChange {
  return { oldFilePath: path, newFilePath: path, type: "M", additions: 1, deletions: 0 };
}

function details(hash: string, paths: string[]): GitCommitDetails {
  return {
    hash,
    parents: [],
    author: "Alice",
    email: "alice@example.com",
    committer: "Alice",
    committerEmail: "alice@example.com",
    authorDate: 1700000000,
    commitDate: 1700000000,
    body: "Commit",
    fileChanges: paths.map(change)
  };
}

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function fileRows() {
  return Array.from(document.querySelectorAll<HTMLElement>("#commitDetails .gitFile"));
}

function filePathOf(file: Element | null | undefined) {
  return decodeURIComponent((<HTMLElement>file).dataset.newfilepath!);
}

function fileRow(path: string) {
  return fileRows().find((f) => filePathOf(f) === path)!;
}

/** The paths of the file rows carrying `tabindex="0"` — exactly one whenever
 *  Tab can reach the list. */
function fileTabStopPaths() {
  return Array.from(document.querySelectorAll<HTMLElement>('#commitDetails [tabindex="0"]')).map(
    (f) => filePathOf(f)
  );
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

/** A redraw the user did not ask for: automatic loading on scroll. */
function redrawByAutoLoad() {
  parkViewportAt(NEAR_BOTTOM);
  document.dispatchEvent(new Event("scroll"));
  receive(commitsResponse(nextPage));
}

function clickViewType(viewType: GG.FileViewType) {
  document
    .querySelector<HTMLElement>(`.cdvFileViewBtn[data-viewtype="${viewType}"]`)!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("the Commit Details View file list's tab stop across a redraw", () => {
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
    receive({
      command: "commitDetails",
      commitDetails: details("aaa111", ["src/a.ts", "src/b.ts", "CHANGELOG.md", "README.md"])
    });
  });

  // The issue's own reproduction: arrow to the third file, leave the list,
  // let a page of commits load, come back with Tab.
  describe("after arrowing to the third file and leaving the list", () => {
    let tabStopsAfterRedraw: string[] = [];

    beforeAll(() => {
      expect(fileRows().map((f) => filePathOf(f))).toEqual([
        "src/a.ts",
        "src/b.ts",
        "CHANGELOG.md",
        "README.md"
      ]);
      fileRows()[0].focus();
      press("ArrowDown");
      press("ArrowDown");
      expect(filePathOf(document.activeElement)).toBe("CHANGELOG.md");
      row("aaa111").focus();

      redrawByAutoLoad();
      tabStopsAfterRedraw = fileTabStopPaths();
    });

    it("redraws the list without focus in it", () => {
      expect(row("ccc333")).not.toBeNull();
      expect(document.getElementById("commitDetails")!.contains(document.activeElement)).toBe(
        false
      );
    });

    it("keeps the tab stop on the third file, not the first", () => {
      expect(tabStopsAfterRedraw).toEqual(["CHANGELOG.md"]);
    });
  });

  // The two layouts order the same files differently, so the file's index in
  // one says nothing about where it sits in the other: only the path carries.
  describe("switching between the tree and list layouts", () => {
    let tabStopsInList: string[] = [];
    let indexInList = -1;
    let tabStopsBackInTree: string[] = [];
    let indexBackInTree = -1;

    beforeAll(() => {
      fileRow("src/b.ts").focus();
      row("aaa111").focus();

      clickViewType("File List");
      tabStopsInList = fileTabStopPaths();
      indexInList = fileRows().indexOf(fileRow("src/b.ts"));

      clickViewType("File Tree");
      tabStopsBackInTree = fileTabStopPaths();
      indexBackInTree = fileRows().indexOf(fileRow("src/b.ts"));
    });

    it("keeps the tab stop on the same file in the list layout", () => {
      expect(indexInList).toBe(3);
      expect(tabStopsInList).toEqual(["src/b.ts"]);
    });

    it("and again on the way back to the tree", () => {
      expect(indexBackInTree).toBe(1);
      expect(tabStopsBackInTree).toEqual(["src/b.ts"]);
    });
  });

  // The same view redrawn with a different set of files — what a fresh answer
  // for the same commit brings, the uncommitted changes row being the everyday
  // case. The file is gone, so its position is the best remaining guess.
  describe("when the file holding the tab stop is gone after the redraw", () => {
    let tabStopsAtSameIndex: string[] = [];
    let tabStopsClamped: string[] = [];

    beforeAll(() => {
      // Left on `src/b.ts`, the second row, by the scenario above.
      expect(fileTabStopPaths()).toEqual(["src/b.ts"]);
      receive({
        command: "commitDetails",
        commitDetails: details("aaa111", ["src/a.ts", "CHANGELOG.md", "README.md"])
      });
      tabStopsAtSameIndex = fileTabStopPaths();

      fileRow("README.md").focus();
      row("aaa111").focus();
      receive({
        command: "commitDetails",
        commitDetails: details("aaa111", ["src/a.ts", "CHANGELOG.md"])
      });
      tabStopsClamped = fileTabStopPaths();
    });

    it("puts the tab stop on the row now at the same index", () => {
      expect(tabStopsAtSameIndex).toEqual(["CHANGELOG.md"]);
    });

    it("clamps that index to the shorter list", () => {
      expect(tabStopsClamped).toEqual(["CHANGELOG.md"]);
    });
  });

  // A different view is an opening, not a redraw: the remembered file belongs
  // to the view it was in, even when the next one has a file at the same path.
  describe("when the Commit Details View shows a different commit", () => {
    let tabStopsOnOtherCommit: string[] = [];
    let tabStopsOnReopen: string[] = [];

    beforeAll(() => {
      // `CHANGELOG.md` is the second row of both commits, so neither the path
      // nor the index could tell the two views apart.
      expect(fileTabStopPaths()).toEqual(["CHANGELOG.md"]);
      row("bbb222").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({
        command: "commitDetails",
        commitDetails: details("bbb222", ["src/x.ts", "CHANGELOG.md"])
      });
      tabStopsOnOtherCommit = fileTabStopPaths();

      fileRow("CHANGELOG.md").focus();
      document.getElementById("commitDetailsClose")!.click();
      expect(document.getElementById("commitDetails")).toBeNull();
      row("bbb222").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({
        command: "commitDetails",
        commitDetails: details("bbb222", ["src/x.ts", "CHANGELOG.md"])
      });
      tabStopsOnReopen = fileTabStopPaths();
    });

    it("starts the new view's tab stop on its first file", () => {
      expect(tabStopsOnOtherCommit).toEqual(["src/x.ts"]);
    });

    it("starts again from the first file when the same commit is closed and reopened", () => {
      expect(tabStopsOnReopen).toEqual(["src/x.ts"]);
    });
  });
});
