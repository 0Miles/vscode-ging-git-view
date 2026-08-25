import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The Load More path. `requestLoadCommits` sends nothing when a commit load is
// already in flight — ADR-0018 declined the queue that would have hidden that —
// so a press arriving mid-load must not change any state either, or the view is
// left describing a load that never happened.
//
// One webview is booted for the whole suite and the scenarios run in order
// against it, the way a session actually unfolds; re-importing the module per
// scenario would leave the previous instance still listening on `window`. The
// loaded commit window therefore carries across scenarios: it opens at the
// fixture's initialLoadCommits (300) and each accepted press adds
// loadMoreCount (100).

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
    beforeAll(() => {
      receive(commitsResponse); // settle the previous press
      startInFlightLoad();
      mock.clearMessages();
      click("loadMoreCommitsBtn");
    });

    it("leaves the footer offering the button, with no loading header left spinning", () => {
      expect(document.getElementById("loadingHeader")).toBeNull();
      expect(document.getElementById("loadMoreCommitsBtn")).not.toBeNull();
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
      // to do with it.
      Object.defineProperty(window, "scrollY", { value: 900, configurable: true });
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
});
