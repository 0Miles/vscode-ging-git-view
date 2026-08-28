import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchSearchEntry, GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import {
  createVscodeMock,
  makeViewState,
  NEAR_BOTTOM,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

// Bringing the current find match into view belongs to *moving* to it, not to
// drawing it. `loadCommits` refreshes Find after every redraw, and automatic
// loading on scroll is browsing (ADR-0019): the user asked for neither the load
// nor a jump, so a page arriving underneath an open Find widget has to leave the
// viewport exactly where they scrolled it to. Stepping to another match, and
// changing the search, are the acts that are allowed to move it — this suite
// pins both halves, because a fix that stops the jump by never scrolling again
// would pass the first half alone.
//
// One webview is booted for the whole file and the scenarios run in order
// against it, the way a session actually unfolds; re-importing the module per
// scenario would leave the previous instance still listening on `window` (#80).
// The loaded commit window therefore carries across scenarios: it opens at the
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
    message: "Fix the tip",
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
  },
  {
    hash: "ccc333",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1698000000,
    message: "Fix the base too",
    refs: []
  }
];

/** The page the next load brings back: the same commits with one more behind
 *  them. Loading strictly appends, so the current match is still there — under
 *  a brand new row object, which is what makes the redraw look like a move. */
const nextPage: GitCommitNode[] = [
  ...commits,
  {
    hash: "ddd444",
    parentHashes: [],
    author: "Dave",
    email: "dave@example.com",
    date: 1697000000,
    message: "Initial commit",
    refs: []
  }
];

/** A page deep enough to reach the branch tips the index knows about but the
 *  loaded commit window did not — the only way a match can exist without a row
 *  to centre. */
const deepPage: GitCommitNode[] = [
  ...nextPage,
  {
    hash: "eee555",
    parentHashes: ["fff666"],
    author: "Erin",
    email: "erin@example.com",
    date: 1696000000,
    message: "Deep commit",
    refs: []
  }
];

const deeperPage: GitCommitNode[] = [
  ...deepPage,
  {
    hash: "fff666",
    parentHashes: [],
    author: "Frank",
    email: "frank@example.com",
    date: 1695000000,
    message: "Deeper commit",
    refs: []
  }
];

/** The page that finally contains a commit matching a search which, until it
 *  arrived, had found nothing at all. */
const epiloguePage: GitCommitNode[] = [
  ...deeperPage,
  {
    hash: "ggg777",
    parentHashes: [],
    author: "Gina",
    email: "gina@example.com",
    date: 1694000000,
    message: "Epilogue",
    refs: []
  }
];

/** What a background refresh lands when the current match has been amended out
 *  of the history: the same page minus that one commit. */
const amendedPage: GitCommitNode[] = epiloguePage.filter((c) => c.hash !== "eee555");

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

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function currentMatchHash() {
  return document.querySelector<HTMLElement>("#commitTable tr.commit.findMatchCurrent")?.dataset
    .hash;
}

function findInput() {
  return document.getElementById("findInput") as HTMLInputElement;
}

/** Type a search. The widget searches on `keyup`, one keystroke at a time; the
 *  key itself only has to be neither Enter (step) nor Escape (close). */
function search(query: string) {
  findInput().value = query;
  findInput().dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
}

describe("bringing the current find match into view", () => {
  const scrollTo = vi.fn();
  /** Which rows were centred, by commit hash. The receiver is recorded rather
   *  than the argument: `scrollIntoView` is stubbed on the prototype (jsdom has
   *  none), and every redraw replaces the row objects, so the hash is the only
   *  handle that survives to the assertion. */
  const scrolledTo: (string | undefined)[] = [];
  const scrollIntoView = vi.fn(function (this: Element) {
    scrolledTo.push((this as HTMLElement).dataset.hash);
  });
  let mock: ReturnType<typeof createVscodeMock>;

  function clearMovement() {
    scrollTo.mockClear();
    scrollIntoView.mockClear();
    scrolledTo.length = 0;
  }

  /** The token the webview is currently waiting on. Every load re-requests the
   *  branch index, and `loadBranchSearchIndex` drops anything staler. */
  function latestBranchSearchToken() {
    const requests = mock.sentMessages.filter((m) => m.command === "branchSearch");
    return (requests[requests.length - 1] as { token: number }).token;
  }

  /** What the host answers `branchSearch` with, until a scenario says otherwise.
   *  It is a standing fact about the repo, not a one-off reply: the webview
   *  re-requests it after every load and the host answers every request. */
  let branchIndex: BranchSearchEntry[] = [];

  function deliverBranchIndex(entries: BranchSearchEntry[] = branchIndex) {
    branchIndex = entries;
    receive({
      command: "branchSearch",
      branches: branchIndex,
      token: latestBranchSearchToken(),
      status: null
    });
  }

  /** Reach the bottom of the graph and let the page land. The user is still
   *  scrolling while the request is out, so the viewport moves on underneath it.
   *
   *  The index answer at the end is not decoration. `loadCommits` re-requests
   *  the branch index immediately after refreshing Find, and that answer runs
   *  Find again — so a load that stops at the page stops one message short of
   *  where Find actually settles, and a suite written that way will pass while
   *  the user is being scrolled by the message it never delivered. */
  function autoLoad(page: GitCommitNode[]) {
    parkViewportAt(NEAR_BOTTOM);
    mock.clearMessages();
    clearMovement();
    document.dispatchEvent(new Event("scroll"));
    parkViewportAt(NEAR_BOTTOM + 600);
    receive(commitsResponse(page));
    deliverBranchIndex();
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

  describe("searching", () => {
    beforeAll(() => {
      document.getElementById("findBtn")!.click();
      clearMovement();
      search("fix");
    });

    it("centres the first match", () => {
      expect(currentMatchHash()).toBe("aaa111");
      expect(scrolledTo).toEqual(["aaa111"]);
    });
  });

  describe("a page arriving from automatic loading on scroll", () => {
    beforeAll(() => {
      autoLoad(nextPage);
    });

    it("loads the next page", () => {
      expect(mock.sentMessages.filter((m) => m.command === "loadCommits")).toMatchObject([
        { maxCommits: 400 }
      ]);
      expect(row("ddd444")).not.toBeNull();
    });

    it("moves nothing, least of all back to the current match", () => {
      expect(scrolledTo).toEqual([]);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("still refreshes the highlights over the redrawn rows", () => {
      expect(currentMatchHash()).toBe("aaa111");
      expect(
        Array.from(document.querySelectorAll<HTMLElement>("#commitTable tr.commit.findMatch")).map(
          (el) => el.dataset.hash
        )
      ).toEqual(["aaa111", "ccc333"]);
      expect(document.getElementById("findCount")!.textContent).toContain("1");
    });
  });

  describe("stepping to the next match", () => {
    beforeAll(() => {
      clearMovement();
      document.getElementById("findNext")!.click();
    });

    it("centres it", () => {
      expect(currentMatchHash()).toBe("ccc333");
      expect(scrolledTo).toEqual(["ccc333"]);
    });
  });

  describe("the automatic load after a step", () => {
    beforeAll(() => {
      autoLoad(nextPage);
    });

    it("leaves the match the step centred alone too", () => {
      expect(mock.sentMessages.filter((m) => m.command === "loadCommits")).toMatchObject([
        { maxCommits: 500 }
      ]);
      expect(currentMatchHash()).toBe("ccc333");
      expect(scrolledTo).toEqual([]);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe("changing the search", () => {
    beforeAll(() => {
      clearMovement();
      search("initial");
    });

    it("centres the new current match", () => {
      expect(currentMatchHash()).toBe("ddd444");
      expect(scrolledTo).toEqual(["ddd444"]);
    });
  });

  describe("a branch index that arrives after the search changed", () => {
    /** The state the moment the search was typed, before the index answered. */
    let onSearch: { current: string | undefined; scrolled: (string | undefined)[] };

    beforeAll(() => {
      // The index is fetched once per load and answers late, so a search typed
      // in the meantime resolves against nothing.
      clearMovement();
      search("release");
      onSearch = { current: currentMatchHash(), scrolled: [...scrolledTo] };

      clearMovement();
      deliverBranchIndex([
        { ref: "release-1.0", name: "release-1.0", hash: "ddd444", logDepth: 3 }
      ]);
    });

    it("centres nothing while the search has no match to centre", () => {
      expect(onSearch).toEqual({ current: undefined, scrolled: [] });
    });

    it("centres the match it reveals, even on the commit the last search left in view", () => {
      // Completing the search is part of searching. A search that resolved to
      // nothing settled on nothing, so the index answering it is owed the
      // scroll — even though the commit it lands on is the one the *previous*
      // search had already put on screen.
      expect(currentMatchHash()).toBe("ddd444");
      expect(scrolledTo).toEqual(["ddd444"]);
    });
  });

  describe("a match the loaded commits do not reach yet", () => {
    const index: BranchSearchEntry[] = [
      { ref: "release-1.0", name: "release-1.0", hash: "ddd444", logDepth: 3 },
      { ref: "outer-work", name: "outer-work", hash: "eee555", logDepth: 4 }
    ];
    /** The state the moment the search resolved to a match with no row. */
    let onSearch: { current: string | undefined; scrolled: (string | undefined)[] };
    /** The state once browsing had drawn that row. */
    let afterLoad: { current: string | undefined; scrolled: (string | undefined)[] };

    beforeAll(() => {
      // A branch tip past the end of the loaded commit window: Find can count
      // it and name it, but there is no row to bring into view.
      deliverBranchIndex(index);
      clearMovement();
      search("outer");
      onSearch = { current: currentMatchHash(), scrolled: [...scrolledTo] };

      autoLoad(deepPage);
      afterLoad = { current: currentMatchHash(), scrolled: [...scrolledTo] };

      // And once more with no load behind it at all.
      clearMovement();
      deliverBranchIndex();
    });

    it("centres nothing, having nothing to centre", () => {
      expect(onSearch).toEqual({ current: undefined, scrolled: [] });
      expect(document.getElementById("findCount")!.textContent).toContain("1");
    });

    it("does not chase it when browsing happens to load it", () => {
      expect(afterLoad).toEqual({ current: "eee555", scrolled: [] });
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("nor when the index that load re-requested answers again", () => {
      // Find settled on this target when the search resolved, not when a row
      // finally existed for it — otherwise every re-answered index would read
      // as a new target and re-centre a user who is only browsing.
      expect(currentMatchHash()).toBe("eee555");
      expect(scrolledTo).toEqual([]);
    });
  });

  describe("stepping onto a match the loaded commits do not reach yet", () => {
    const index: BranchSearchEntry[] = [
      { ref: "outer-work", name: "outer-work", hash: "eee555", logDepth: 4 },
      { ref: "outer-edge", name: "outer-edge", hash: "fff666", logDepth: 5 }
    ];
    /** The state while the load the step asked for is still out. */
    let midStep: (string | undefined)[];

    beforeAll(() => {
      deliverBranchIndex(index);
      clearMovement();
      // Two matches now, the second one past the window. Stepping onto it goes
      // out for the branch index, then for the page that would draw it.
      document.getElementById("findNext")!.click();
      deliverBranchIndex();
      midStep = [...scrolledTo];

      receive(commitsResponse(deeperPage));
      deliverBranchIndex();
    });

    it("moves nothing while the page is still on its way", () => {
      expect(midStep).toEqual([]);
    });

    it("centres it once the page arrives", () => {
      // The step is an outstanding move, and this load is the answer to it —
      // the one arrival at `refreshFind` that is owed a scroll however settled
      // the target looks.
      expect(currentMatchHash()).toBe("fff666");
      expect(scrolledTo).toEqual(["fff666"]);
    });
  });

  describe("a search that has found nothing yet", () => {
    beforeAll(() => {
      // Searching, finding nothing, and scrolling on for more history is an
      // ordinary way to use this — and the page that finally holds a match is
      // still a page the user only browsed into.
      clearMovement();
      search("epilogue");
      autoLoad(epiloguePage);
    });

    it("says so, without going there", () => {
      expect(currentMatchHash()).toBe("ggg777");
      expect(document.getElementById("findCount")!.textContent).toContain("1");
      expect(scrolledTo).toEqual([]);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe("a background refresh that amends the current match away", () => {
    /** The state the search left, before the refresh landed. */
    let onSearch: (string | undefined)[];

    beforeAll(() => {
      clearMovement();
      search("deep");
      onSearch = [...scrolledTo];

      clearMovement();
      // No scroll trigger and no button: a refresh arriving on its own, with
      // the current match no longer in the history it brings — and the index it
      // re-requests answering behind it, as one always does.
      receive(commitsResponse(amendedPage));
      deliverBranchIndex();
    });

    it("centred the search's own match on the way in", () => {
      expect(onSearch).toEqual(["eee555"]);
    });

    it("moves the current match on without moving the user", () => {
      // The target changed, and the user had nothing to do with it. A redraw
      // may not read its own edit as a request.
      expect(document.querySelector('tr.commit[data-hash="eee555"]')).toBeNull();
      expect(currentMatchHash()).toBe("fff666");
      expect(scrolledTo).toEqual([]);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });
});
