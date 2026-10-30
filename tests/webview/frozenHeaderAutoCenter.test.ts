import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";

import {
  VIEWPORT_HEIGHT,
  createVscodeMock,
  makeViewState,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

/* frozenHeader.test.ts with "Center Commit Details View" on: centring has to
 * mean centred in what the frozen header (#206) leaves visible, not in the
 * whole viewport, or the opened commit sits half a header too high. A suite of
 * its own because the setting is read once, when the webview starts.
 *
 * The strip's height is declared as Chromium resolves main.css's rule — see
 * the note atop frozenHeader.test.ts. */
const FROZEN = 63;

/* Where the opened commit and its details land, in viewport coordinates.
 * jsdom performs no layout, so the boxes are declared: the page stands
 * SCROLLED px down, the opened commit's 24px row starts ROW_TOP px down the
 * viewport, and the panel under it is whatever height the test has dragged it
 * to — never the 250px default, so nothing here holds by matching a built-in
 * constant. */
const SCROLLED = 1500;
const ROW_TOP = 500;
const ROW_HEIGHT = 24;
let opened = "";
let panelHeight = 0;

function rect(top: number, height: number): DOMRect {
  return new DOMRect(0, top, 800, height);
}

const viewState = makeViewState({ autoCenterCommitDetailsView: true });

const commits: GitCommitNode[] = [
  {
    hash: "bbb222",
    parentHashes: ["aaa111"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000100,
    message: "Second commit",
    refs: [{ hash: "bbb222", name: "main", type: "head" }]
  },
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "First commit",
    refs: []
  }
];

function details(hash: string): GitCommitDetails {
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
    fileChanges: []
  };
}

/** Open `hash`'s Commit Details View with the panel `height` px tall. Each
 *  test opens a different commit: the view is brought into view once per
 *  commit, not again for one already open (ADR-0019). */
function openDetails(hash: string, height: number) {
  opened = hash;
  panelHeight = height;
  document
    .querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  receive({ command: "commitDetails", commitDetails: details(hash) });
}

describe("centring the Commit Details View under the frozen header", () => {
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
        if (this.id === "commitDetails") return rect(ROW_TOP + ROW_HEIGHT, panelHeight);
        if (this.dataset.hash === opened) return rect(ROW_TOP, ROW_HEIGHT);
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
      head: "bbb222",
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

  it("centres the commit and its details in the part of the viewport below the header", () => {
    scrollTo.mockClear();
    parkViewportAt(SCROLLED);
    openDetails("aaa111", 400);
    // On the page, the row starts at 1500 + 500 = 2000 and the panel ends
    // 24 + 400 further down, at 2424: the block's middle is 2212. The visible
    // rows span 63..768 of the viewport, middle 415.5, so the page has to
    // stand at 2212 - 415.5 = 1796.5 — not 32px further on, as it did when
    // the middle was a hard-coded offsetTop + 177 (#216).
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 2212 - (VIEWPORT_HEIGHT + FROZEN) / 2);
  });

  it("keeps the commit's row in sight when the panel is too tall to centre", () => {
    scrollTo.mockClear();
    parkViewportAt(SCROLLED);
    openDetails("bbb222", 800);
    // Row plus panel is 824px, taller than the 705px of visible rows: centred,
    // the page would stand at 2000 + 412 - 415.5 = 1996.5 and leave the row's
    // top 3.5px down the viewport, under the 63px header. The row is what was
    // clicked, so it stays in sight, right under the header: 2000 - 63.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 2000 - FROZEN);
  });
});
