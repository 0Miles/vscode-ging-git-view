import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { VIEWPORT_HEIGHT, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

/* The control bar and the column headers are frozen at the top of the view
 * (#206): rows scroll *under* them. The browser's own scroll-into-view learns
 * that from the rows' `scroll-margin-top` in main.css; these are the scrolls
 * the webview works out for itself, which have to clear the same strip. The
 * one that opens the Commit Details View has suites of its own:
 * cdvBringIntoView.test.ts and frozenHeaderAutoCenter.test.ts.
 *
 * jsdom does no layout, so the strip's height is declared here the way
 * Chromium resolves main.css's rule: the 32px bar plus the 31px header row.
 * What is under test is the arithmetic following whatever the rows' margin
 * says — not main.css's own number, which only a real layout can check. */
const FROZEN = 63;

const viewState = makeViewState();

const commits: GitCommitNode[] = ["aaa111", "bbb222", "ccc333"].map((hash, i, all) => ({
  hash,
  parentHashes: i + 1 < all.length ? [all[i + 1]] : [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000 - i,
  message: "Commit " + hash,
  refs: i === 0 ? [{ hash, name: "main", type: "head" }] : []
}));

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function headerRow() {
  return document.querySelector<HTMLElement>("#commitTable #tableColHeaders")!;
}

describe("the frozen header", () => {
  /** What was asked to scroll into view, by element. jsdom has no
   *  `scrollIntoView`, so the stub on the prototype records its receiver. */
  const scrolledIntoView: Element[] = [];
  const frozenStyle = document.createElement("style");

  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    frozenStyle.textContent = `#commitTable tr { scroll-margin-top: ${FROZEN}px; }`;
    document.head.appendChild(frozenStyle);
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledIntoView.push(this);
    };
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

  afterAll(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    frozenStyle.remove();
  });

  beforeEach(() => {
    scrolledIntoView.length = 0;
  });

  describe("keyboard focus on the column headers", () => {
    // Only the header *cells* stick; the header row's own box stays at the top
    // of the page. Bringing it "into view" would haul the page all the way
    // back up for a row the user is already looking at.
    it("walks onto the header row, into a column and back out without scrolling", () => {
      row("aaa111").focus();
      scrolledIntoView.length = 0;
      press("ArrowUp");
      expect(document.activeElement).toBe(headerRow());
      press("ArrowRight");
      expect((document.activeElement as HTMLElement).matches(".tableColHeader")).toBe(true);
      press("ArrowLeft");
      expect(document.activeElement).toBe(headerRow());
      expect(scrolledIntoView).toEqual([]);
    });

    it("still brings a commit into view when stepping back down to it", () => {
      headerRow().focus();
      scrolledIntoView.length = 0;
      press("ArrowDown");
      expect(scrolledIntoView).toEqual([row("aaa111")]);
    });
  });

  describe("Page Up/Down", () => {
    it("jumps by what is visible below the header, keeping its overlap", () => {
      // A screenful is the viewport less the strip, less the 48px overlap kept
      // to re-orient against: 768 - 63 - 48.
      const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
      try {
        row("aaa111").focus();
        press("PageDown");
        expect(scrollBy).toHaveBeenLastCalledWith(0, VIEWPORT_HEIGHT - FROZEN - 48);
        press("PageUp");
        expect(scrollBy).toHaveBeenLastCalledWith(0, -(VIEWPORT_HEIGHT - FROZEN - 48));
      } finally {
        scrollBy.mockRestore();
      }
    });
  });
});
