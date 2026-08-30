import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  createVscodeMock,
  makeViewState,
  NEAR_BOTTOM,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

// Automatic loading on scroll is the continuation of *browsing*, so it must be
// indistinguishable from browsing: it may not move anything the user did not
// ask to have moved (ADR-0019). Pressing the button is an operation and may
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

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

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

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function tabStops() {
  return Array.from(document.querySelectorAll<HTMLElement>('#commitTable [tabindex="0"]'));
}

/** Activate a context-menu item by its label. `toBeDefined`, not
 *  `not.toBeNull`: `find` yields `undefined` when nothing matches, and a null
 *  check would pass on it — leaving the scenario to fail later, somewhere that
 *  reads like the behaviour under test (issue #131). */
function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).toBeDefined();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function dialogIsOpen() {
  return document.getElementById("dialog")!.classList.contains("active");
}

/** What the footer says the loaded commit window is, or null when it is still
 *  at the opening count and the footer carries no line. */
function windowCount() {
  return document.getElementById("loadedCommitWindowCount")?.textContent ?? null;
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

  // A modal dialog is the one state in which a scroll event is certainly not
  // browsing the graph: `#dialogBacking` is an unscrollable full-screen
  // overlay, so a wheel over it chains to the document and `scroll` fires
  // while the user is reading a question about something else entirely.
  //
  // ADR-0019's grounds for keeping automatic loading are that the loaded
  // commit window it widens stays visible and has a way back — and the footer
  // carrying both is behind that same overlay. Widening the window there is
  // widening it out of the user's sight, with the one control that shrinks it
  // covered up.
  //
  // Scoped to the wheel, and the scoping is the point rather than an omission.
  // `showDialog` provides no focus containment — no `inert` on the background,
  // no focus trap, no focus move — so a dialog is not modal to the keyboard at
  // all, and every background control stays tabbable and pressable behind it
  // (#141). The footer's Load More is simply the one of those that reaches
  // this suite's subject: Tab and Space still widen the window from behind the
  // overlay, which findLoadPlanBoundAtConsent drives its scenarios with, so it
  // is pinned somewhere rather than assumed here. A defect in the dialog, not
  // in this listener.
  describe("reaching the bottom while a modal dialog is up", () => {
    let requestedBehindTheDialog: GG.RequestMessage[] = [];
    let windowBehindTheDialog: string | null = null;
    let requestedAfterDismissal: GG.RequestMessage[] = [];

    beforeAll(() => {
      // A real dialog, raised the way the user raises one.
      row("aaa111").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      clickItem(L.addTag + E);
      expect(dialogIsOpen(), "the dialog the scenario is about").toBe(true);

      parkViewportAt(NEAR_BOTTOM);
      mock.clearMessages();
      document.dispatchEvent(new Event("scroll"));
      requestedBehindTheDialog = loadCommitsRequests();
      windowBehindTheDialog = windowCount();

      document
        .getElementById("dialogDismiss")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      mock.clearMessages();
      document.dispatchEvent(new Event("scroll"));
      requestedAfterDismissal = loadCommitsRequests();
      receive(commitsResponse(nextPage));
    });

    it("asks for nothing, the user being sat in a dialog rather than browsing", () => {
      expect(requestedBehindTheDialog).toHaveLength(0);
    });

    it("leaves the loaded commit window at the width the user last saw", () => {
      // 600: the opening 300 plus the three accepted loads above. The window
      // may not grow behind an overlay that hides both the count and the
      // control that shrinks it.
      expect(windowBehindTheDialog).toBe(L.loadedCommitWindow.replace("{0}", "600"));
    });

    it("is deferred by the dialog, not switched off by it", () => {
      expect(requestedAfterDismissal).toMatchObject([{ maxCommits: 700 }]);
      expect(windowCount()).toBe(L.loadedCommitWindow.replace("{0}", "700"));
    });
  });
});
