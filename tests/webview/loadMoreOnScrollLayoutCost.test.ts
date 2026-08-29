import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import {
  createVscodeMock,
  makeViewState,
  parkViewportAt,
  receive,
  setupHtml,
  VIEWPORT_HEIGHT
} from "./setup";

// The half of the switch loadMoreOnScrollDisabled.test.ts cannot reach: the
// feature *on*, with more commits still available, which is the one state in
// which the near-the-bottom threshold is allowed to measure the page at all.
//
// Reading `document.body.offsetHeight` lays the document out synchronously, and
// the scroll handler used to do it on every tick for as long as anything was
// still loadable (ADR-0019 left that noted and unaddressed). The reads are
// counted rather than the value stubbed, because "measures once and then stops"
// and "measures every tick" return the same number and only differ in cost.
//
// The threshold is deliberately held false throughout the first two scenarios —
// a page far taller than the viewport — so the measurement is observed without
// a load landing and re-rendering underneath it.

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
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
  }
];

/** One more commit behind the loaded set — a real redraw, the way the page
 *  actually changes height under a user who is scrolling. */
const nextPage: GitCommitNode[] = [
  { ...commits[1], parentHashes: ["ccc333"] },
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

/** Far enough from the bottom that `innerHeight + scrollY >= height - 250` is
 *  false, so measuring is all that happens. */
const TALL_PAGE = 100000;
/** Short enough that the same viewport is now within 250px of the bottom. */
const SHORT_PAGE = VIEWPORT_HEIGHT + 100;

/** Drain the microtask queue and *nothing else* — no timers, no frames.
 *
 *  Deliberately not `setTimeout`. MutationObserver delivers its records on a
 *  microtask, so an invalidation that has landed by the time this resolves is
 *  one that lands before any later turn can run — which is the half of the
 *  ordering argument that makes the cache safe rather than merely cheap, and
 *  the half that rules out ResizeObserver, whose broadcast is never a
 *  microtask. A `setTimeout` flush would accept either and pin neither.
 *
 *  The other half is not observable here and this file does not pretend to
 *  cover it: that a real `scroll` event is dispatched by the user agent from
 *  the rendering steps — a later turn by construction, so the invalidation is
 *  always already done — rests on the frame lifecycle, and jsdom runs no
 *  rendering steps at all (it implements neither `requestAnimationFrame` nor
 *  `ResizeObserver`). Every scroll event below is a synchronous synthetic
 *  dispatch. That half is guaranteed by the HTML spec and by nothing in this
 *  repository; see `observePageHeight`. */
function flushMicrotasks() {
  return Promise.resolve();
}

describe("what the near-the-bottom threshold costs while it is live", () => {
  let mock: ReturnType<typeof createVscodeMock>;
  let heightReads = 0;
  let pageHeight = TALL_PAGE;

  function loadCommitsRequests() {
    return mock.sentMessages.filter((m) => m.command === "loadCommits");
  }

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    // The same offset the shared setup starts at, restated because both page
    // heights below are declared against a viewport at the top and the scenario
    // should not have to be read elsewhere to know that. The viewport's height
    // is the shared one, imported above.
    parkViewportAt(0);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse(commits));

    // Installed after the graph has been rendered, so only the scroll path is
    // being measured.
    Object.defineProperty(document.body, "offsetHeight", {
      get() {
        heightReads++;
        return pageHeight;
      },
      configurable: true
    });
    await flushMicrotasks();
    mock.clearMessages(); // drop the opening load, so only scrolling is counted
  });

  describe("a burst of scroll ticks with nothing changing underneath", () => {
    beforeAll(() => {
      heightReads = 0;
      for (let i = 0; i < 10; i++) document.dispatchEvent(new Event("scroll"));
    });

    it("lays the document out once, not once per tick", () => {
      expect(heightReads).toBe(1);
    });

    it("asks for nothing, being nowhere near the bottom", () => {
      expect(loadCommitsRequests()).toHaveLength(0);
    });
  });

  describe("a redraw that could have moved the bottom", () => {
    beforeAll(async () => {
      receive(commitsResponse(nextPage));
      await flushMicrotasks();
      heightReads = 0;
      for (let i = 0; i < 10; i++) document.dispatchEvent(new Event("scroll"));
    });

    it("measures the page again rather than trusting a stale height", () => {
      expect(heightReads).toBe(1);
    });
  });

  describe("a redraw that leaves the user near the bottom", () => {
    beforeAll(async () => {
      pageHeight = SHORT_PAGE;
      mock.clearMessages();
      receive(commitsResponse(commits));
      await flushMicrotasks();
      document.dispatchEvent(new Event("scroll"));
    });

    it("still trips the threshold — a cached height may not swallow a load", () => {
      expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 400 }]);
    });
  });
});
