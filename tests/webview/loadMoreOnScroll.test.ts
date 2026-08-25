import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// Automatic loading on scroll is the continuation of *browsing*, so it must be
// indistinguishable from browsing: it may not move anything the user did not
// ask to have moved (ADR-0018). Pressing the button is an operation and may
// take the viewport with it; reaching the bottom of the graph is not.
//
// The load is asynchronous, and the user is by definition still scrolling when
// it fires — so anything that pins or restores a scroll offset taken at the
// moment of the trigger is pinning a stale one, and lands the user somewhere
// they had already left.
//
// One webview is booted for the whole file and the scenarios run in order
// against it, the way a session actually unfolds; re-importing the module per
// scenario would leave the previous instance still listening on `window`. The
// loaded commit window therefore carries across scenarios: it opens at the
// fixture's initialLoadCommits (300) and each accepted load adds loadMoreCount
// (100).

const viewState = makeViewState({ loadMoreAutomatically: true });

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
    parentHashes: ["ccc333"],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
  }
];

/** The page the next load brings back: the same commits with one more behind
 *  them. Loading strictly appends, so every row the user could have been on is
 *  still here — under a brand new row object, which is the whole problem. */
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

/** A page the focused commit is *not* in — what a sort or filter change lands,
 *  and the one case where focus cannot be put back where it was. */
const pageWithoutBase: GitCommitNode[] = [commits[0], nextPage[2]];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(loaded: GitCommitNode[]): GG.ResponseMessage {
  return {
    command: "loadCommits",
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
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 }
  ]
};

const VIEWPORT_HEIGHT = 768;
const PAGE_HEIGHT = 10000;
/** The offset at which `innerHeight + scrollY >= offsetHeight - 250` first
 *  holds — the threshold, worked out from the stubbed geometry rather than
 *  copied off the implementation. */
const NEAR_BOTTOM = PAGE_HEIGHT - 250 - VIEWPORT_HEIGHT;

/** Give the page a size. jsdom performs no layout, so `scrollY` is 0 and
 *  `body.offsetHeight` is 0 unless told otherwise — which makes
 *  `innerHeight + scrollY >= offsetHeight - 250` true wherever the viewport
 *  is. A suite that skips this passes for the wrong reason and can never show
 *  the negative case at all. Stubbed per suite with `Object.defineProperty`,
 *  as contextMenuPosition.test.ts stubs the viewport it measures against. */
function stubPageGeometry() {
  Object.defineProperty(window, "innerHeight", { value: VIEWPORT_HEIGHT, configurable: true });
  Object.defineProperty(document.body, "offsetHeight", {
    value: PAGE_HEIGHT,
    configurable: true
  });
}

/** Park the viewport at a known offset. jsdom never scrolls on its own, and
 *  its scrollTo is unimplemented, so the offset has to be declared. */
function parkViewportAt(offset: number) {
  Object.defineProperty(window, "scrollY", { value: offset, configurable: true });
  Object.defineProperty(window, "pageYOffset", { value: offset, configurable: true });
}

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function tabStops() {
  return Array.from(document.querySelectorAll<HTMLElement>('#commitTable [tabindex="0"]'));
}

describe("automatic loading on scroll", () => {
  const scrollTo = vi.fn();
  const scrollIntoView = vi.fn();
  let mock: ReturnType<typeof createVscodeMock>;

  function loadCommitsRequests() {
    return mock.sentMessages.filter((m) => m.command === "loadCommits");
  }

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    stubPageGeometry();
    // jsdom implements neither, so record what the webview asks for instead.
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = scrollIntoView;
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse(commits));
  });

  describe("reaching the bottom with the Commit Details View open", () => {
    let requestedOnTrigger: GG.RequestMessage[] = [];

    beforeAll(() => {
      // A CDV open above the viewport is what used to drag the user back: its
      // re-render re-ran the scroll that brings a CDV into view.
      row("aaa111").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({ command: "commitDetails", commitDetails: tipDetails });

      parkViewportAt(NEAR_BOTTOM);
      scrollTo.mockClear();
      mock.clearMessages();

      document.dispatchEvent(new Event("scroll"));
      requestedOnTrigger = loadCommitsRequests();

      // The user keeps going while the request is out — held PageDown, wheel
      // momentum, or simply still scrolling.
      parkViewportAt(NEAR_BOTTOM + 600);
      receive(commitsResponse(commits));
    });

    it("loads the next page without being asked", () => {
      expect(requestedOnTrigger).toMatchObject([{ maxCommits: 400 }]);
    });

    it("keeps the CDV open across the load", () => {
      expect(document.getElementById("commitDetails")).not.toBeNull();
      expect(document.querySelector<HTMLElement>(".commit.commitDetailsOpen")?.dataset.hash).toBe(
        "aaa111"
      );
    });

    it("never moves the viewport, least of all back to where the load was triggered", () => {
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe("scrolling while still far from the bottom", () => {
    beforeAll(() => {
      parkViewportAt(NEAR_BOTTOM - 1);
      mock.clearMessages();
      document.dispatchEvent(new Event("scroll"));
    });

    it("asks for nothing", () => {
      expect(loadCommitsRequests()).toHaveLength(0);
    });
  });

  describe("browsing to the end of the loaded commits with the arrow keys", () => {
    let focusedAfterLoad: Element | null = null;
    let movedOnRestore: unknown[] = [];

    beforeAll(() => {
      // The canonical ADR-0014 case: keyboard only, nothing expanded.
      document.getElementById("commitDetailsClose")!.click();

      row("aaa111").focus();
      press("ArrowDown"); // onto the last loaded commit
      parkViewportAt(NEAR_BOTTOM);
      mock.clearMessages();
      scrollTo.mockClear();
      scrollIntoView.mockClear();

      // Moving focus scrolls the row into view, and that scroll is what trips
      // the threshold — the user pressed a key, not a scrollbar.
      document.dispatchEvent(new Event("scroll"));
      receive(commitsResponse(nextPage));
      focusedAfterLoad = document.activeElement;
      // Snapshot now: the cases below press keys of their own, and a key press
      // is entitled to scroll.
      movedOnRestore = [
        ...scrollTo.mock.calls,
        ...scrollIntoView.mock.calls,
        ...mock.sentMessages.filter((m) => m.command === "commitDetails")
      ];
    });

    it("loads the next page", () => {
      expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 500 }]);
      expect(row("ccc333")).not.toBeNull();
    });

    it("leaves focus on the same commit, whose row the redraw destroyed", () => {
      expect((<HTMLElement>focusedAfterLoad).dataset.hash).toBe("bbb222");
      expect(focusedAfterLoad).toBe(row("bbb222"));
      expect(tabStops()).toEqual([row("bbb222")]);
    });

    it("puts focus back without moving anything", () => {
      // Restoring focus is not a focus *move*: no scroll of any kind, and the
      // Commit Details View — which follows focus while open — is not asked to
      // reload a commit the user never arrowed onto.
      expect(movedOnRestore).toEqual([]);
    });

    it("carries on down from there rather than back to the first row", () => {
      press("ArrowDown");
      expect(document.activeElement).toBe(row("ccc333"));
    });
  });

  describe("when the commit holding focus is not in the page that arrives", () => {
    let focusedAfterLoad: Element | null = null;

    beforeAll(() => {
      row("bbb222").focus();
      parkViewportAt(NEAR_BOTTOM);
      mock.clearMessages();

      document.dispatchEvent(new Event("scroll"));
      // A sort or filter change lands instead: the focused commit is gone.
      receive(commitsResponse(pageWithoutBase));
      focusedAfterLoad = document.activeElement;
    });

    it("drops focus rather than putting it somewhere the user never was", () => {
      expect(document.querySelector('tr.commit[data-hash="bbb222"]')).toBeNull();
      expect(focusedAfterLoad).toBe(document.body);
    });

    it("still leaves the graph a tab stop, on the first commit", () => {
      expect(tabStops()).toEqual([row("aaa111")]);
    });

    it("enters the grid from the top on the next arrow key, as it always did", () => {
      press("ArrowDown");
      expect(document.activeElement).toBe(row("aaa111"));
    });
  });
});
