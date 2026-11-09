import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import {
  commitDetails,
  createVscodeMock,
  makeViewState,
  parkViewportAt,
  receive,
  setupHtml,
  VIEWPORT_HEIGHT
} from "./setup";

/* Opening the Commit Details View inline, with "Center Commit Details View"
 * off: the page moves only when the commit or its panel is out of sight, and
 * then only as far as it takes (frozenHeaderAutoCenter.test.ts has it on).
 *
 * Where the two sit is measured on screen, not worked out from the panel's
 * `offsetTop`. That is measured from the table, and the table does not start
 * at a fixed depth: the conflict banner, while a merge or rebase is stopped on
 * one, sits above it and pushes it down by its own height (#228). jsdom does
 * no layout, so the boxes are declared — the page stands SCROLLED px down, the
 * opened commit's 24px row starts at whatever viewport depth the test puts it,
 * and the panel under it is whatever height the test has dragged it to, never
 * the 250px default.
 *
 * The frozen header's height is declared as Chromium resolves main.css's rule —
 * see the note atop frozenHeader.test.ts. */
const FROZEN = 63;
/** The gap the webview leaves under a panel it scrolls up into view. */
const GAP = 16;
const SCROLLED = 1500;
const ROW_HEIGHT = 24;
let opened = "";
let rowTop = 0;
let panelHeight = 0;

function rect(top: number, height: number): DOMRect {
  return new DOMRect(0, top, 800, height);
}

const viewState = makeViewState({ autoCenterCommitDetailsView: false });

const HASHES = ["aaa111", "bbb222", "ccc333", "ddd444", "eee555"];
const commits: GitCommitNode[] = HASHES.map((hash, i, all) => ({
  hash,
  parentHashes: i + 1 < all.length ? [all[i + 1]] : [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000 - i,
  message: "Commit " + hash,
  refs: i === 0 ? [{ hash, name: "main", type: "head" }] : []
}));

/** Open `hash`'s Commit Details View with its row `top` px down the viewport
 *  and the panel `height` px tall. Each test opens a different commit: the
 *  view is brought into view once per commit, not again for one already open
 *  (ADR-0019). */
function openDetails(hash: string, top: number, height: number) {
  opened = hash;
  rowTop = top;
  panelHeight = height;
  document
    .querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  receive({ command: "commitDetails", commitDetails: commitDetails(hash) });
}

describe("bringing an opening Commit Details View into view", () => {
  const scrollTo = vi.fn();
  const frozenStyle = document.createElement("style");

  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    frozenStyle.textContent = `#commitTable tr { scroll-margin-top: ${FROZEN}px; }`;
    document.head.appendChild(frozenStyle);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(HTMLTableRowElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement): DOMRect {
        if (this.id === "commitDetails") return rect(rowTop + ROW_HEIGHT, panelHeight);
        if (this.dataset.hash === opened) return rect(rowTop, ROW_HEIGHT);
        return rect(0, 0);
      }
    });
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
    // The stub shadows Element's own method; deleting it un-shadows it.
    delete (HTMLTableRowElement.prototype as { getBoundingClientRect?: unknown })
      .getBoundingClientRect;
    frozenStyle.remove();
    parkViewportAt(0);
  });

  beforeEach(() => {
    scrollTo.mockClear();
    parkViewportAt(SCROLLED);
  });

  it("brings a commit sitting under the header out from under it", () => {
    // The row starts 18px down the viewport: inside the window but behind the
    // 63px strip — on screen, and unseen. It moves to right under the strip.
    openDetails("aaa111", 18, 300);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, SCROLLED + 18 - FROZEN);
  });

  it("leaves a commit and its panel alone while both are in sight", () => {
    // Row at 108, clear of the header; panel ends at 108 + 24 + 300 = 432.
    openDetails("bbb222", 108, 300);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("brings a panel running off the bottom up into view, wherever the table starts", () => {
    // The panel ends at 400 + 24 + 356 = 780, 12px past the bottom of the
    // 768px viewport. The page moves just far enough to leave the gap under
    // it: 780 - (768 - 16) = 28. Worked out from offsetTop, this assumed the
    // table started right under the 32px bar, and so missed by the conflict
    // banner's height whenever one was showing above the table.
    openDetails("ccc333", 400, 356);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, SCROLLED + 780 - (VIEWPORT_HEIGHT - GAP));
  });

  it("keeps the commit's row in sight when the panel is too tall to fit", () => {
    // The panel ends at 400 + 24 + 900 = 1324: bringing its bottom up to the
    // gap would take 572px and carry the row (400 - 572 = -172) off the top.
    // The row is what was clicked, so it stops right under the header: 337px.
    openDetails("ddd444", 400, 900);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, SCROLLED + 400 - FROZEN);
  });
});
