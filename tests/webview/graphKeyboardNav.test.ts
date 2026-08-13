import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode, GitFileChange } from "@/backend/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState();

const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: ["def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: [{ hash: "abc123", name: "main", type: "head" }]
  },
  {
    hash: "def456",
    parentHashes: ["ghi789"],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Fix bug",
    refs: []
  },
  {
    hash: "ghi789",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1698000000,
    message: "Initial commit",
    refs: []
  }
];

const fileChanges: GitFileChange[] = [
  { oldFilePath: "a.ts", newFilePath: "a.ts", type: "M", additions: 1, deletions: 0 },
  { oldFilePath: "b.ts", newFilePath: "b.ts", type: "M", additions: 2, deletions: 1 }
];

function detailsFor(hash: string): GitCommitDetails {
  return {
    hash,
    parents: [],
    author: "Alice",
    email: "alice@example.com",
    committer: "Alice",
    committerEmail: "alice@example.com",
    authorDate: 1700000000,
    commitDate: 1700000000,
    body: "Body",
    fileChanges
  };
}

function press(key: string, init: KeyboardEventInit = {}) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function headerRow() {
  return document.querySelector<HTMLElement>("#commitTable #tableColHeaders")!;
}

function tabStops() {
  return Array.from(document.querySelectorAll<HTMLElement>('#commitTable [tabindex="0"]'));
}

function menu() {
  return document.getElementById("contextMenu")!;
}

function fileRows() {
  return Array.from(document.querySelectorAll<HTMLElement>("#commitDetails .gitFile"));
}

function loadGraph() {
  receive({
    command: "loadBranches",
    branches: ["main"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
  receive({
    command: "loadCommits",
    commits,
    head: "abc123",
    moreCommitsAvailable: false,
    hard: true
  });
}

describe("commit table keyboard navigation", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    loadGraph();
  });

  beforeEach(() => {
    menu().className = "";
    menu().innerHTML = "";
    // Start every case from the top of the graph rather than wherever the
    // previous one left the roving tab stop.
    row("abc123").focus();
  });

  describe("roving tabindex", () => {
    it("renders every row focusable but keeps exactly one tab stop", () => {
      expect(row("abc123").getAttribute("tabindex")).not.toBeNull();
      expect(row("def456").getAttribute("tabindex")).not.toBeNull();
      expect(headerRow().getAttribute("tabindex")).not.toBeNull();
      expect(tabStops()).toHaveLength(1);
    });

    it("moves the tab stop to whatever last held focus", () => {
      press("ArrowDown");
      expect(document.activeElement).toBe(row("def456"));
      expect(tabStops()).toEqual([row("def456")]);
    });

    it("marks the table up as a grid", () => {
      const table = document.querySelector("#commitTable table")!;
      expect(table.getAttribute("role")).toBe("grid");
      expect(row("abc123").getAttribute("role")).toBe("row");
      expect(row("abc123").querySelector("td")!.getAttribute("role")).toBe("gridcell");
    });
  });

  describe("Up/Down move between rows", () => {
    it("steps down to the next commit and back up again", () => {
      press("ArrowDown");
      expect(document.activeElement).toBe(row("def456"));
      press("ArrowDown");
      expect(document.activeElement).toBe(row("ghi789"));
      press("ArrowUp");
      expect(document.activeElement).toBe(row("def456"));
    });

    it("stops at the last row instead of wrapping", () => {
      row("ghi789").focus();
      press("ArrowDown");
      expect(document.activeElement).toBe(row("ghi789"));
    });

    it("reaches the column header row above the first commit", () => {
      press("ArrowUp");
      expect(document.activeElement).toBe(headerRow());
    });

    it("does not scroll the view", () => {
      const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
      try {
        press("ArrowDown");
        press("ArrowUp");
        expect(scrollBy).not.toHaveBeenCalled();
      } finally {
        scrollBy.mockRestore();
      }
    });
  });

  describe("Page Up/Down scroll", () => {
    it("scrolls a screenful in each direction", () => {
      const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
      try {
        press("PageDown");
        expect(scrollBy.mock.calls[0][1]).toBeGreaterThan(0);

        scrollBy.mockClear();
        press("PageUp");
        expect(scrollBy.mock.calls[0][1]).toBeLessThan(0);
      } finally {
        scrollBy.mockRestore();
      }
    });

    it("leaves the focused row where it is", () => {
      vi.spyOn(window, "scrollBy").mockImplementation(() => {});
      try {
        press("PageDown");
        expect(document.activeElement).toBe(row("abc123"));
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("Left/Right walk what a row contains", () => {
    it("enters the row's ref chip and steps back out to the row", () => {
      const chip = row("abc123").querySelector<HTMLElement>(".gitRef")!;

      press("ArrowRight");
      expect(document.activeElement).toBe(chip);
      press("ArrowLeft");
      expect(document.activeElement).toBe(row("abc123"));
    });

    it("reaches the column headers from the header row", () => {
      headerRow().focus();
      press("ArrowRight");
      expect(document.activeElement).toBe(
        headerRow().querySelector<HTMLElement>(".tableColHeader")
      );
    });

    it("leaves a row with nothing in it alone", () => {
      row("def456").focus();
      press("ArrowRight");
      expect(document.activeElement).toBe(row("def456"));
    });
  });

  describe("raising a context menu from the keyboard", () => {
    it("opens the commit menu on Shift+F10", () => {
      press("F10", { shiftKey: true });
      expect(menu().classList.contains("active")).toBe(true);
      expect(menu().textContent).toContain("Add Tag");
    });

    it("opens the commit menu on the Context Menu key", () => {
      press("ContextMenu");
      expect(menu().classList.contains("active")).toBe(true);
    });

    it("gives the ref chip its own menu rather than the row's", () => {
      row("abc123").querySelector<HTMLElement>(".gitRef")!.focus();
      press("ContextMenu");
      expect(menu().classList.contains("active")).toBe(true);
      // The branch chip's menu, not the commit's behind it.
      expect(menu().textContent).toContain("Rename Branch");
      expect(menu().textContent).not.toContain("Add Tag");
    });

    it("anchors the menu to the focused row, not to the pointer", () => {
      const target = row("def456");
      target.focus();
      // jsdom performs no layout, so give the row a box to hang the menu off.
      target.getBoundingClientRect = () =>
        ({ left: 40, bottom: 120, top: 96, right: 400, width: 360, height: 24 }) as DOMRect;

      press("ContextMenu");

      // Bottom-left corner of the row, less the 2px overlap the menu always
      // keeps with whatever raised it.
      expect(parseFloat(menu().style.left)).toBe(38);
      expect(parseFloat(menu().style.top)).toBe(118);
    });
  });

  describe("with the Commit Details View open", () => {
    function openDetails(hash: string) {
      // Clicking the row that is already expanded closes it, so start closed.
      document.getElementById("commitDetailsClose")?.click();
      row(hash).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({ command: "commitDetails", commitDetails: detailsFor(hash) });
    }

    beforeEach(() => {
      openDetails("abc123");
      mock.clearMessages();
    });

    it("swaps the panel to the commit the arrow keys land on", () => {
      row("abc123").focus();
      press("ArrowDown");

      expect(document.activeElement).toBe(row("def456"));
      expect(mock.sentMessages).toContainEqual(
        expect.objectContaining({ command: "commitDetails", commitHash: "def456" })
      );
    });

    it("moves between file rows when focus is in the file list", () => {
      const files = fileRows();
      expect(files.length).toBe(2);

      files[0].focus();
      press("ArrowDown");
      expect(document.activeElement).toBe(files[1]);
      press("ArrowUp");
      expect(document.activeElement).toBe(files[0]);
    });

    it("keeps focus in the file list rather than walking out into the commits", () => {
      const files = fileRows();
      files[files.length - 1].focus();
      press("ArrowDown");

      expect(document.activeElement).toBe(files[files.length - 1]);
      expect(mock.sentMessages.some((m) => m.command === "commitDetails")).toBe(false);
    });

    it("raises the file's own menu on Shift+F10", () => {
      fileRows()[0].focus();
      press("F10", { shiftKey: true });

      expect(menu().classList.contains("active")).toBe(true);
      expect(menu().textContent).toContain("Copy File Path to Clipboard");
    });
  });
});
