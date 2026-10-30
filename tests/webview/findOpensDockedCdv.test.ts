import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";

import {
  VIEWPORT_HEIGHT,
  clickId,
  createVscodeMock,
  makeViewState,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

/* Find in "open details" mode, opening a docked Commit Details View that was
 * closed (#256). Find centred the match itself, in the whole window — nothing
 * was docked yet, so the rows had no bottom scroll margin — and then the panel
 * opened a beat later and centred it again, between the header and the panel
 * (#231): a second jump of half the panel's height. With centring on, the
 * opening is the one scroll, so Find leaves the viewport to it. The heights
 * are declared as in dockedCdvAutoCenter.test.ts. */
const FROZEN = 63;
const DOCKED = 254;
const SCROLLED = 1500;
const ROW_HEIGHT = 24;
const ROW_TOP = 600;

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

function search(query: string) {
  const input = document.getElementById("findInput") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
}

describe("Find opening a closed docked Commit Details View", () => {
  const scrollTo = vi.fn();
  /** Which rows Find centred, by hash — every redraw replaces the row objects. */
  const centred: (string | undefined)[] = [];
  const scrollIntoView = vi.fn(function (this: Element, arg?: ScrollIntoViewOptions) {
    if (arg?.block === "center") centred.push((this as HTMLElement).dataset.hash);
  });
  const marginStyle = document.createElement("style");
  const MIDDLE = (FROZEN + VIEWPORT_HEIGHT - DOCKED) / 2;
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    marginStyle.textContent =
      `#commitTable tr { scroll-margin-top: ${FROZEN}px; }` +
      `body.cdvDocked #commitTable tr { scroll-margin-bottom: ${DOCKED}px; }`;
    document.head.appendChild(marginStyle);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = scrollIntoView;
    Object.defineProperty(HTMLTableRowElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement): DOMRect {
        return this.dataset.hash === "bbb222"
          ? new DOMRect(0, ROW_TOP, 800, ROW_HEIGHT)
          : new DOMRect(0, 0, 800, 0);
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
    clickId("findBtn");
    clickId("findOpenCdv");
    expect(document.getElementById("commitDetails")).toBeNull();

    parkViewportAt(SCROLLED);
    scrollTo.mockClear();
    centred.length = 0;
    mock.clearMessages();
    search("Commit bbb");
  });

  afterAll(() => {
    delete (HTMLTableRowElement.prototype as { getBoundingClientRect?: unknown })
      .getBoundingClientRect;
    marginStyle.remove();
    parkViewportAt(0);
  });

  it("asks for the match's details", () => {
    expect(mock.sentOf("commitDetails").map((m) => m.commitHash)).toEqual(["bbb222"]);
  });

  it("does not centre the match itself first", () => {
    expect(centred).toEqual([]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("centres it once, between the header and the panel, when the panel opens", () => {
    receive({ command: "commitDetails", commitDetails: details("bbb222") });
    expect(document.getElementById("commitDetails")!.classList.contains("docked")).toBe(true);
    expect(centred).toEqual([]);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, SCROLLED + ROW_TOP + ROW_HEIGHT / 2 - MIDDLE);
  });

  // Find left the centring to an opening, and the opening never comes: the
  // details could not be loaded. The match still has to come into view.
  describe("when the next match's details cannot be loaded", () => {
    beforeAll(() => {
      scrollTo.mockClear();
      centred.length = 0;
      search("Commit ccc");
      expect(centred).toEqual([]);
      receive({ command: "commitDetails", commitDetails: null });
    });

    it("closes the view", () => {
      expect(document.getElementById("commitDetails")).toBeNull();
    });

    it("centres the match itself after all", () => {
      expect(centred).toEqual(["ccc333"]);
    });
  });
});
