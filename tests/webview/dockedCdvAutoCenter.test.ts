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

/* dockedCdvBringIntoView.test.ts with "Center Commit Details View" on: docked,
 * the panel covers the bottom of the window, so "centred" means centred
 * between the frozen header and the panel's top (#231), not in the whole
 * viewport. What is centred is the clicked row alone — the panel is not under
 * it. A suite of its own because the setting is read once, when the webview
 * starts. The heights are declared as in dockedCdvScroll.test.ts. */
const FROZEN = 63;
const DOCKED = 254;
const SCROLLED = 1500;
const ROW_HEIGHT = 24;
let opened = "";
let rowTop = 0;

function rect(top: number, height: number): DOMRect {
  return new DOMRect(0, top, 800, height);
}

const viewState = makeViewState({
  commitDetailsViewLocation: "Docked to Bottom",
  autoCenterCommitDetailsView: true
});

const HASHES = ["aaa111", "bbb222", "ccc333"];
const commits: GitCommitNode[] = HASHES.map((hash, i, all) => ({
  hash,
  parentHashes: i + 1 < all.length ? [all[i + 1]] : [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000 - i,
  message: "Commit " + hash,
  refs: i === 0 ? [{ hash, name: "main", type: "head" }] : []
}));

function loadCommits() {
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: "aaa111",
    moreCommitsAvailable: false,
    hard: true
  });
}

/** A soft refresh that found something new — a tag pushed from elsewhere — so
 *  the table, and the panel with it, is redrawn. One that found nothing would
 *  short-circuit before drawing anything. */
function refreshWithNewTag() {
  const last = commits[commits.length - 1];
  receive({
    command: "loadCommits",
    token: 0,
    commits: [
      ...commits.slice(0, -1),
      { ...last, refs: [{ hash: last.hash, name: "v1", type: "tag" }] }
    ],
    head: "aaa111",
    moreCommitsAvailable: false,
    hard: false
  });
}

/** Open `hash`'s Commit Details View with its row `top` px down the viewport.
 *  Each test opens a different commit: the view is brought into view once
 *  per commit, not again for one already open (ADR-0019). */
function openDetails(hash: string, top: number) {
  opened = hash;
  rowTop = top;
  document
    .querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  receive({ command: "commitDetails", commitDetails: commitDetails(hash) });
}

describe("centring the commit between the frozen header and the docked panel", () => {
  const scrollTo = vi.fn();
  const marginStyle = document.createElement("style");
  /** The middle of what is visible: the rows between the header and the panel. */
  const MIDDLE = (FROZEN + VIEWPORT_HEIGHT - DOCKED) / 2;

  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    marginStyle.textContent =
      `#commitTable tr { scroll-margin-top: ${FROZEN}px; }` +
      `body.cdvDocked #commitTable tr { scroll-margin-bottom: ${DOCKED}px; }`;
    document.head.appendChild(marginStyle);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(HTMLTableRowElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement): DOMRect {
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
    loadCommits();
  });

  afterAll(() => {
    // The stub shadows Element's own method; deleting it un-shadows it.
    delete (HTMLTableRowElement.prototype as { getBoundingClientRect?: unknown })
      .getBoundingClientRect;
    marginStyle.remove();
    parkViewportAt(0);
  });

  beforeEach(() => {
    scrollTo.mockClear();
    parkViewportAt(SCROLLED);
  });

  it("centres a commit the panel opens over in what is left above the panel", () => {
    // The row's middle is 600 + 12 = 612 down the viewport; the visible rows
    // span 63..514, middle 288.5 — not the 415.5 of the whole window below
    // the header, which would leave the row under the panel's top edge.
    openDetails("aaa111", 600);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, SCROLLED + 600 + ROW_HEIGHT / 2 - MIDDLE);
  });

  it("centres a commit sitting under the header too", () => {
    // The header's height is read off a commit row: the docked panel is a
    // <div> under <body> with no scroll margin of its own.
    openDetails("bbb222", 18);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, SCROLLED + 18 + ROW_HEIGHT / 2 - MIDDLE);
  });

  it("does not centre the same commit again when a refresh redraws it", () => {
    openDetails("ccc333", 600);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    scrollTo.mockClear();
    const panel = document.getElementById("commitDetails");
    refreshWithNewTag();
    expect(document.getElementById("commitDetails")).not.toBe(panel);
    expect(document.getElementById("commitDetails")!.classList.contains("docked")).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
