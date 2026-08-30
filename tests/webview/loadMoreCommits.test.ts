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

// The Load More path. `requestLoadCommits` sends nothing when a commit load is
// already in flight — ADR-0019 declined the queue that would have hidden that —
// so a press arriving mid-load must not change any state either, or the view is
// left describing a load that never happened.
//
// One webview is booted for the whole suite and the scenarios run in order
// against it, the way a session actually unfolds; re-importing the module per
// scenario would leave the previous instance still listening on `window`. The
// loaded commit window therefore carries across scenarios: it opens at the
// fixture's initialLoadCommits (300) and each accepted press adds
// loadMoreCount (100).
//
// The last scenario is not about the button at all: it is where the shared page
// geometry in setup.ts gets its assertion, and it is here because this file is
// an ordinary suite that declares no height of its own — the position every
// suite the pin exists for is written from. loadMoreOnScroll.test.ts, which
// owns the automatic path, cannot stand in for that: it parks itself at
// NEAR_BOTTOM on purpose.

const L = getWebviewLocalizedStrings();

const viewState = makeViewState();

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
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  commits,
  head: "aaa111",
  moreCommitsAvailable: true,
  hard: true
};

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

let mock: ReturnType<typeof createVscodeMock>;

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Put a commit load in flight: refresh, answer the branches half, withhold
 *  the commits half. The rendered graph — Load More button included — stands
 *  untouched until the commits arrive. */
function startInFlightLoad() {
  click("refreshBtn");
  receive(branchesResponse);
}

/** Whatever the dialog is currently saying, or "" when none is up. */
function dialogText() {
  const elem = document.getElementById("dialog")!;
  return elem.classList.contains("active") ? (elem.textContent ?? "") : "";
}

/** Close whatever dialog is standing. Load-bearing in this file rather than
 *  merely tidy: the scroll listener is gated on a dialog being up (#124), and
 *  the last scenario here dispatches scrolls. Optional-chained for the reason
 *  droppedLoadRequests spells out on its copy. */
function dismissAnyDialog() {
  document
    .getElementById("dialogDismiss")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function loadCommitsRequests() {
  return mock.sentMessages.filter((m) => m.command === "loadCommits");
}

/** Open a commit's CDV, answering the request the click sends. */
function expandCommit(hash: string) {
  const row = document.querySelector<HTMLElement>(`.commit[data-hash="${hash}"]`);
  expect(row, hash).not.toBeNull();
  row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  receive({ command: "commitDetails", commitDetails: tipDetails });
}

/** The commit the open CDV is anchored to, or null when none is open. */
function anchoredCommit() {
  if (document.getElementById("commitDetails") === null) return null;
  return document.querySelector<HTMLElement>(".commit.commitDetailsOpen")?.dataset.hash ?? null;
}

describe("Load More", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
  });

  describe("pressed with nothing in flight", () => {
    beforeAll(() => {
      mock.clearMessages();
      click("loadMoreCommitsBtn");
    });

    it("requests the next page, widening the loaded commit window", () => {
      expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 400, hard: true }]);
    });

    it("swaps the footer button for a loading header", () => {
      expect(document.getElementById("loadMoreCommitsBtn")).toBeNull();
      expect(document.getElementById("loadingHeader")).not.toBeNull();
    });
  });

  describe("pressed while a load is in flight", () => {
    beforeAll(() => {
      receive(commitsResponse); // settle the previous press
      startInFlightLoad();
      mock.clearMessages();
    });

    // Both halves belong to one test on purpose. Asserting only that the press
    // is dropped would also pass against an implementation that drops it
    // permanently — which is exactly the bug: the old code widened the window
    // and raised its in-progress flag before discovering the request could not
    // go out, so the flag never came back down and Load More stayed dead for
    // the life of the panel.
    it("sends nothing, then sends the request once the in-flight load finishes", () => {
      click("loadMoreCommitsBtn");
      expect(loadCommitsRequests()).toHaveLength(0);

      receive(commitsResponse);
      mock.clearMessages();

      click("loadMoreCommitsBtn");
      expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 500 }]);
    });
  });

  describe("dropped because a load is in flight", () => {
    let refusal = "";
    let footerAfterTheRefusal: HTMLElement | null = null;
    let spinnerAfterTheRefusal: HTMLElement | null = null;

    beforeAll(() => {
      receive(commitsResponse); // settle the previous press
      startInFlightLoad();
      mock.clearMessages();
      click("loadMoreCommitsBtn");
      refusal = dialogText();
      footerAfterTheRefusal = document.getElementById("loadMoreCommitsBtn");
      spinnerAfterTheRefusal = document.getElementById("loadingHeader");
      dismissAnyDialog();
    });

    it("leaves the footer offering the button, with no loading header left spinning", () => {
      expect(spinnerAfterTheRefusal).toBeNull();
      expect(footerAfterTheRefusal).not.toBeNull();
    });

    it("says so, rather than answering a press with nothing", () => {
      // The button the user pressed does not move, nothing loads, no error, and
      // the next press works — the shape of a dead button, not of a refusal
      // (`confirmForRepoAndHead`, and #79's same refusal for the
      // commit-ordering menu). This is the *press*; the scroll listener shares
      // this function and must stay silent, which loadMoreOnScroll pins.
      expect(refusal).toContain(L.dialogLoadMoreBusy);
    });

    describe("and once the in-flight load lands", () => {
      let requestedOnTheRetry: GG.RequestMessage[] = [];

      beforeAll(() => {
        receive(commitsResponse);
        mock.clearMessages();
        click("loadMoreCommitsBtn");
        requestedOnTheRetry = loadCommitsRequests();
      });

      it("takes the same press, so the refusal said something true", () => {
        // The message tells the user to wait and try again, so it has to be
        // worth acting on. Without this the refusal would read identically
        // against a button that had gone dead for good — which is the failure
        // the guard's own docstring records having caused once already.
        expect(requestedOnTheRetry).toMatchObject([{ maxCommits: 600 }]);
      });
    });
  });

  describe("pressed with the Commit Details View open", () => {
    let anchoredBefore: string | null = null;
    let scrollTo = vi.fn();

    beforeAll(() => {
      receive(commitsResponse); // settle the previous press
      expandCommit("aaa111");
      anchoredBefore = anchoredCommit();

      // jsdom has no layout and does not implement scrollTo, so park the
      // viewport at a known offset and record what the press asks the browser
      // to do with it. Still nowhere near the bottom of the page the shared
      // setup pins, so nothing loads automatically underneath this.
      parkViewportAt(900);
      scrollTo = vi.fn();
      window.scrollTo = scrollTo as unknown as typeof window.scrollTo;

      click("loadMoreCommitsBtn");
      receive(commitsResponse);
    });

    it("has the CDV open before the press", () => {
      expect(anchoredBefore).toBe("aaa111");
    });

    // This also stands in for the content jump the press used to cause, which
    // jsdom cannot measure because it has no layout. Measured in a real
    // Chromium: swapping the whole table keeps the scroll position exactly
    // (0px of drift, because loading only appends), but removing an expanded
    // CDV sitting above the viewport leaves `scrollY` untouched while the
    // content slides up by the panel's full height — 253px, about ten rows.
    // Keeping the row is the only fix; restoring `scrollY` around the load
    // does nothing, since the browser never moved it. Inline mode only: a
    // docked CDV is `position: fixed` and outside the flow.
    it("keeps the CDV open on the same commit across the load", () => {
      expect(anchoredCommit()).toBe("aaa111");
    });

    it("does not scroll the viewport at all", () => {
      // Keeping the CDV open is not enough on its own. Re-rendering it used to
      // re-run the scroll that brings a CDV into view (detailsPanel.autoScroll,
      // on by default), dragging the user from wherever they were back up to
      // the expanded commit. Bringing it into view belongs to opening it, so a
      // redraw must ask the browser for nothing.
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  // What this pins is `setup.ts`'s PAGE_HEIGHT, from the position of a suite
  // that never asked for one — which is every webview suite but a handful.
  // jsdom performs no layout, so an unpinned `document.body.offsetHeight` is 0
  // and the webview's near-the-bottom test degenerates to
  // `innerHeight + scrollY >= -250`, true wherever the viewport is. With
  // `loadMoreAutomatically` shipped on and the fixture above near-shipped by
  // design, any scroll event in such a suite would smuggle in a `loadCommits`
  // that reads like the code under test asking twice. Nobody has been bitten
  // yet — the suites that dispatch scrolls all stub a height — which is exactly
  // why the guard belongs somewhere they do not have to know about.
  //
  // This suite parks the viewport (at 900, above), but it declares no height
  // and no viewport size, so the threshold it meets is the shared one.
  //
  // The negative needs three things true of the scenario or it proves nothing:
  // more commits available, no load in flight, and automatic loading switched
  // on. None of them may live in a comment — a comment cannot fail. The first
  // two are pinned by the footer, which `renderFooter` draws only when both
  // hold. The third is pinned by scrolling to the bottom afterwards and
  // watching the same webview ask: a control, not a second copy of
  // loadMoreOnScroll.test.ts, and the reason it has to be in this file is that
  // a fixture flipped here alone is invisible to every other one.
  describe("the near-the-bottom threshold, met by a suite that declares no geometry", () => {
    let whileFarFromBottom: GG.RequestMessage[] = [];
    let footerWhileFarFromBottom: HTMLElement | null = null;
    let onceParkedAtTheBottom: GG.RequestMessage[] = [];

    beforeAll(() => {
      // The previous scenario settled its own press, so nothing is in flight.
      mock.clearMessages();
      document.dispatchEvent(new Event("scroll"));
      whileFarFromBottom = loadCommitsRequests();
      footerWhileFarFromBottom = document.getElementById("loadMoreCommitsBtn");

      // Same webview, same event, same everything but where the viewport is.
      parkViewportAt(NEAR_BOTTOM);
      mock.clearMessages();
      document.dispatchEvent(new Event("scroll"));
      onceParkedAtTheBottom = loadCommitsRequests();

      receive(commitsResponse); // settle it
      parkViewportAt(900); // and leave the viewport where it was found
    });

    // Both halves in one test on purpose. "Sent nothing" is also what a scenario
    // with nothing left to load would report, and what one with a load already
    // in flight would report. The claim goes first and the guard second, so a
    // real regression still fails on the stray request rather than on the button
    // that regression took away.
    it("asks for nothing, the threshold being a real one", () => {
      expect(whileFarFromBottom).toHaveLength(0);
      expect(
        footerWhileFarFromBottom,
        "footer must still be offering Load More, or this scenario had nothing to ask for"
      ).not.toBeNull();
    });

    // The control. Without it the test above passes just as well against a
    // webview with automatic loading switched off, which is the one premise the
    // footer cannot speak for — measured: flipping this file's fixture to
    // `loadMoreAutomatically: false` left the whole suite green.
    it("asks once the same viewport reaches the bottom, so automatic loading was live", () => {
      expect(onceParkedAtTheBottom).toHaveLength(1);
    });
  });
});
