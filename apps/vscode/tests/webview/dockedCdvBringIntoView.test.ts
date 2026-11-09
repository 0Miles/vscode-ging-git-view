import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import {
  commitDetails,
  createVscodeMock,
  graphRow,
  makeViewState,
  receive,
  setupHtml
} from "./setup";

/* cdvBringIntoView.test.ts with the Commit Details View docked to the bottom
 * and "Center Commit Details View" off (dockedCdvAutoCenter.test.ts has it
 * on). Docked, the panel is not under the commit at all: it is a fixed strip
 * over the bottom of the window, and rows scroll under it the way they scroll
 * under the frozen header (#217) — so a row clicked low down is exactly the
 * one the panel opens over (#231).
 *
 * Not centring, the row is brought out from under it with the same
 * nearest-edge `scrollIntoView` the arrow keys use to step onto a row, which
 * main.css's scroll margins keep clear of the header and the panel. Where that
 * lands is the browser's to work out, and jsdom does no layout, so what this
 * suite holds is *when* it happens: once per view, on opening it, and never
 * for a redraw of the same one (ADR-0019). One webview per file (#80): both
 * settings are read at boot. */
const viewState = makeViewState({
  commitDetailsViewLocation: "Docked to Bottom",
  autoCenterCommitDetailsView: false
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

describe("bringing an opening docked Commit Details View's commit into view", () => {
  const scrollTo = vi.fn();
  /** Each `scrollIntoView` call: the element it was made on, and its options. */
  const scrolledIntoView: [Element, unknown][] = [];

  /** Click `hash`'s row and answer with its details. Only what happens once
   *  the details arrive is kept: clicking a row is a focus move of its own,
   *  and may bring the row into view for that reason. */
  function openDetails(hash: string) {
    graphRow(hash).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    scrolledIntoView.length = 0;
    receive({ command: "commitDetails", commitDetails: commitDetails(hash) });
  }

  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
      scrolledIntoView.push([this, arg]);
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
  });

  beforeEach(() => {
    scrollTo.mockClear();
  });

  it("brings the commit's row into view the way the arrow keys do", () => {
    openDetails("aaa111");
    expect(document.getElementById("commitDetails")!.classList.contains("docked")).toBe(true);
    expect(scrolledIntoView).toEqual([[graphRow("aaa111"), { block: "nearest" }]]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not bring the same commit into view again when a refresh redraws it", () => {
    const panel = document.getElementById("commitDetails");
    scrolledIntoView.length = 0;
    refreshWithNewTag();
    expect(document.getElementById("commitDetails")).not.toBe(panel);
    expect(document.getElementById("commitDetails")!.classList.contains("docked")).toBe(true);
    expect(scrolledIntoView).toEqual([]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("brings the next commit opened into view in its turn", () => {
    openDetails("bbb222");
    expect(scrolledIntoView).toEqual([[graphRow("bbb222"), { block: "nearest" }]]);
  });
});
