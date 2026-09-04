import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { mergeContextMenuActionsVisibility } from "@/backend/utils/contextMenuVisibility";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState({
  contextMenuActionsVisibility: mergeContextMenuActionsVisibility({}),
  defaultColumnVisibility: { date: true, author: false, commit: true }
});

const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: ["def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: []
  },
  {
    hash: "def456",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Initial commit",
    refs: []
  }
];

const menu = () => document.getElementById("contextMenu")!;
const menuItems = () => Array.from(menu().querySelectorAll<HTMLElement>(".contextMenuItem"));

function itemStartingWith(prefix: string) {
  const item = menuItems().find((li) => (li.textContent ?? "").trim().startsWith(prefix));
  if (item === undefined) {
    throw new Error(
      `menu item "${prefix}" not found; items: ${menuItems()
        .map((i) => i.textContent)
        .join(" | ")}`
    );
  }
  return item;
}

function gutterOf(item: HTMLElement) {
  return item.querySelector<HTMLElement>(".contextMenuItemGutter")!;
}

function openCommitMenu() {
  const row = document.querySelector<HTMLElement>('tr.commit[data-hash="abc123"]')!;
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  return row;
}

function dateHeader() {
  return document.querySelector<HTMLElement>('.tableColHeader[data-col="date"]')!;
}

function openColumnHeaderMenu() {
  const header = dateHeader();
  header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  return header;
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("context menu gutter, activation and keyboard navigation", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
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
      head: "abc123",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  describe("gutter rendering", () => {
    it("draws an icon for actions that have one and leaves the slot empty otherwise", () => {
      openCommitMenu();

      // Git operations get a glyph...
      expect(gutterOf(itemStartingWith("Merge")).querySelector("svg")).not.toBeNull();
      expect(gutterOf(itemStartingWith("Cherry Pick")).querySelector("svg")).not.toBeNull();
      // ...while actions that read fine from their label alone stay blank.
      expect(gutterOf(itemStartingWith("Copy Commit Hash")).querySelector("svg")).toBeNull();
      expect(gutterOf(itemStartingWith("Export Patch")).querySelector("svg")).toBeNull();

      // Every item reserves the gutter even when it holds nothing, so the
      // labels of icon-less items stay aligned with the rest.
      for (const item of menuItems()) {
        expect(gutterOf(item)).not.toBeNull();
      }
    });

    it("marks toggles up as menuitemcheckbox and checks only the enabled ones", () => {
      openColumnHeaderMenu();

      const date = itemStartingWith("Date");
      const author = itemStartingWith("Author");
      expect(date.getAttribute("role")).toBe("menuitemcheckbox");
      expect(date.getAttribute("aria-checked")).toBe("true");
      expect(author.getAttribute("aria-checked")).toBe("false");

      // The checkmark lives in the same gutter the icons use.
      expect(gutterOf(date).querySelector("svg")).not.toBeNull();
      expect(gutterOf(author).querySelector("svg")).toBeNull();
    });

    it("gives plain actions role=menuitem and dividers role=separator", () => {
      openCommitMenu();
      expect(itemStartingWith("Merge").getAttribute("role")).toBe("menuitem");
      expect(itemStartingWith("Merge").hasAttribute("aria-checked")).toBe(false);
      expect(menu().querySelector('[role="separator"]')).not.toBeNull();
    });
  });

  describe("activation", () => {
    it("runs the action when the click lands on the gutter glyph rather than the row", () => {
      expect(dateHeader().classList.contains("hidden")).toBe(false);

      openColumnHeaderMenu();
      const glyph = gutterOf(itemStartingWith("Date")).querySelector("svg")!;

      // Regression: the handler used to read ev.target.dataset.index, which is
      // undefined once the click lands on a child of the <li>. Toggling the
      // column proves the right item ran, not merely that nothing threw.
      glyph.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(dateHeader().classList.contains("hidden")).toBe(true);
      expect(menu().classList.contains("active")).toBe(false);

      // Put it back so the later cases see the menu they expect.
      openColumnHeaderMenu();
      itemStartingWith("Date").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(dateHeader().classList.contains("hidden")).toBe(false);
    });
  });

  describe("keyboard navigation", () => {
    it("moves onto the first item on ArrowDown and wraps at either end", () => {
      openCommitMenu();
      const items = menuItems();
      expect(document.activeElement).toBe(menu());

      press("ArrowDown");
      expect(document.activeElement).toBe(items[0]);
      press("ArrowDown");
      expect(document.activeElement).toBe(items[1]);
      press("ArrowUp");
      expect(document.activeElement).toBe(items[0]);
      // Wrapping backwards off the first item lands on the last.
      press("ArrowUp");
      expect(document.activeElement).toBe(items[items.length - 1]);
    });

    it("jumps to the ends with Home and End", () => {
      openCommitMenu();
      const items = menuItems();

      press("End");
      expect(document.activeElement).toBe(items[items.length - 1]);
      press("Home");
      expect(document.activeElement).toBe(items[0]);
    });

    it("runs the focused action on Enter", () => {
      openCommitMenu();
      const copyItem = itemStartingWith("Copy Commit Subject");
      copyItem.focus();
      mock.clearMessages();
      press("Enter");

      expect(mock.sentMessages).toContainEqual(
        expect.objectContaining({ command: "copyToClipboard", type: "Commit Subject" })
      );
      expect(menu().classList.contains("active")).toBe(false);
    });

    it("dismisses on Tab instead of letting focus walk out of the menu", () => {
      openCommitMenu();
      press("ArrowDown");
      press("Tab");
      expect(menu().classList.contains("active")).toBe(false);
    });

    it("hands focus back to the source element after keyboard dismissal", () => {
      const row = openCommitMenu();
      press("ArrowDown");
      press("Tab");
      expect(document.activeElement).toBe(row);
      // Closing the menu leaves the row focusable — that is how it was reached
      // in the first place — and the table still holds a single tab stop, so
      // Tab steps over the graph rather than through every commit in it.
      expect(row.hasAttribute("tabindex")).toBe(true);
      expect(document.querySelectorAll('#commitTable [tabindex="0"]')).toHaveLength(1);
    });

    it("leaves focus alone when the menu is dismissed by clicking elsewhere", () => {
      const row = openCommitMenu();
      // A real click moves focus on mousedown, well before the document click
      // listener dismisses the menu — so by then focus is already gone from it
      // and must not be dragged back to the row.
      const input = document.getElementById("findInput")!;
      input.focus();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(menu().classList.contains("active")).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(document.activeElement).not.toBe(row);
    });
  });
});
