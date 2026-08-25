import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// The loaded commit window on screen. Widening it is cheap — one press, or a
// held PageDown once automatic loading is on — and it survives every panel
// reload, so it follows the user back. ADR-0018 keeps automatic loading only
// on the condition that the window is visible and has a way back, so this is
// that condition, not a nicety: without it the panel silently gets slower and
// the only ways out are four navigations done for entirely different reasons.
//
// One webview is booted for the whole suite and the scenarios run in order
// against it, the way a session actually unfolds; re-importing the module per
// scenario would leave the previous instance still listening on `window`. The
// window therefore carries across scenarios: it opens at the fixture's
// initialLoadCommits (300) and each accepted press adds loadMoreCount (100).

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

function commitsResponse(moreCommitsAvailable = true): GG.ResponseMessage {
  return {
    command: "loadCommits",
    commits,
    head: "aaa111",
    moreCommitsAvailable,
    hard: true
  };
}

let mock: ReturnType<typeof createVscodeMock>;
// jsdom implements neither scrolling nor scrollTo, so record what the webview
// asks the browser for instead.
const scrollTo = vi.fn();

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function loadCommitsRequests() {
  return mock.sentMessages.filter((m) => m.command === "loadCommits");
}

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

/** The footer's loaded-commit-window line, or null when the footer does not
 *  carry one. */
function windowLine() {
  return document.getElementById("loadedCommitWindow");
}

/** Just the count the line reads, without the reset control beside it. */
function windowCount() {
  return document.getElementById("loadedCommitWindowCount")?.textContent ?? null;
}

/** Put a commit load in flight: refresh, answer the branches half, withhold
 *  the commits half. Everything already rendered stands untouched until the
 *  commits arrive. */
function startInFlightLoad() {
  click("refreshBtn");
  receive(branchesResponse);
}

describe("the loaded commit window on screen", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse());
  });

  describe("sitting at the opening count", () => {
    it("adds nothing to the footer at all", () => {
      // The state the panel opens in, and the one the reset returns it to.
      // Chrome describing it would be on screen for every user who never
      // widened anything, saying only that nothing has happened yet.
      expect(document.getElementById("loadMoreCommitsBtn")).not.toBeNull();
      expect(windowLine()).toBeNull();
    });
  });

  describe("once Load More has widened it", () => {
    beforeAll(() => {
      click("loadMoreCommitsBtn");
      receive(commitsResponse());
    });

    it("says how far the graph has been widened", () => {
      expect(windowCount()).toBe(L.loadedCommitWindow.replace("{0}", "400"));
    });

    it("offers a way back to the opening count", () => {
      expect(document.getElementById("resetLoadedCommitWindowBtn")!.textContent).toBe(
        L.resetLoadedCommitWindow.replace("{0}", "300")
      );
    });
  });

  describe("widened until the whole history is in", () => {
    beforeAll(() => {
      click("loadMoreCommitsBtn");
      receive(commitsResponse(false));
    });

    it("still offers the way back, though the footer has no Load More button left", () => {
      // The line's condition is whether the window was widened, not whether
      // Load More happens to be showing. Reading it off the button would blank
      // the line exactly where it is worth most: the user reached the end of
      // the history by widening the window, and now carries the widest window
      // of the session with no sign of it and no way back.
      expect(document.getElementById("loadMoreCommitsBtn")).toBeNull();
      expect(windowCount()).toBe(L.loadedCommitWindow.replace("{0}", "500"));
    });
  });

  describe("resetting it", () => {
    let requestedOnPress: GG.RequestMessage[] = [];

    beforeAll(() => {
      receive(commitsResponse()); // there is more history again
      mock.clearMessages();
      scrollTo.mockClear();
      click("resetLoadedCommitWindowBtn");
      requestedOnPress = loadCommitsRequests();
      receive(commitsResponse());
    });

    it("reloads the graph at the opening count", () => {
      expect(requestedOnPress).toMatchObject([{ maxCommits: 300, hard: true }]);
    });

    it("takes the line with it, there being nothing left to reset", () => {
      expect(windowLine()).toBeNull();
    });

    it("puts the viewport back at the top, where the panel opens", () => {
      // The one path that shrinks the loaded set on purpose, and the only one
      // that may move the viewport for it: the user asked for the opening
      // state, and this is part of it. Leaving them where they were pins them
      // to the bottom of the now far shorter page — and with automatic loading
      // on, the browser's own clamping scroll trips the near-the-bottom
      // threshold, which widens the window straight back out. The reset would
      // undo half of itself in front of the user who asked for it.
      expect(scrollTo).toHaveBeenCalledWith(0, 0);
    });
  });

  // The same rule every other load entry follows: the whole thing happens or
  // none of it does, because `requestLoadCommits` sends nothing while a load is
  // in flight and the caller cannot undo what it changed first (ADR-0018).
  describe("the reset entry pressed while a load is in flight", () => {
    let requestedOnPress: GG.RequestMessage[] = [];
    let lineOnPress: string | null = null;

    beforeAll(() => {
      click("loadMoreCommitsBtn"); // widen it again, to 400
      receive(commitsResponse());
      startInFlightLoad();
      mock.clearMessages();
      click("resetLoadedCommitWindowBtn");
      requestedOnPress = loadCommitsRequests();
      lineOnPress = windowCount();
    });

    it("sends nothing", () => {
      expect(requestedOnPress).toHaveLength(0);
    });

    it("leaves the line reading the window the graph still has", () => {
      expect(lineOnPress).toBe(L.loadedCommitWindow.replace("{0}", "400"));
    });

    describe("and once the in-flight load lands", () => {
      beforeAll(() => {
        receive(commitsResponse());
      });

      it("left the loaded commit window itself untouched", () => {
        mock.clearMessages();
        click("loadMoreCommitsBtn");
        // 500, not 400: the window still stands where Load More left it. Had
        // the dropped press shrunk it to 300 first, this would ask for 400 —
        // for a graph still showing the 400-commit page, with the line gone
        // and nothing left to say the two had come apart.
        expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 500 }]);
      });

      it("takes the reset again once nothing is in flight", () => {
        receive(commitsResponse());
        mock.clearMessages();
        click("resetLoadedCommitWindowBtn");
        expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 300 }]);
      });
    });
  });

  describe("keyboard focus across the redraw the reset causes", () => {
    let focusedAfterReset: Element | null = null;

    beforeAll(() => {
      receive(commitsResponse()); // settle the previous reset
      click("loadMoreCommitsBtn");
      receive(commitsResponse());

      row("bbb222").focus();
      click("resetLoadedCommitWindowBtn");
      receive(commitsResponse());
      focusedAfterReset = document.activeElement;
    });

    // The footer is not inside the commit table, but `renderTable` rewrites
    // both, and the focus it puts back is read before that rewrite and applied
    // after it. A footer that grew a second control must not land between the
    // two.
    it("leaves focus on the same commit, whose row the redraw destroyed", () => {
      expect(focusedAfterReset).toBe(row("bbb222"));
      expect(document.querySelectorAll('#commitTable [tabindex="0"]')).toHaveLength(1);
    });
  });
});

// Every time the panel becomes visible again, `webview.html` is reset: a full
// reboot followed by a restore from saved state. Snapping the window back to
// the opening count there would mean "glance at another editor tab and come
// back to a graph that threw the loading away" — a far more frequent version of
// the same complaint, not a cure for it (ADR-0018). The window comes back as
// the user left it, and the line comes back with it.
describe("restored into a panel that has just become visible again", () => {
  const savedState: WebViewState = {
    gitRepos: { [DEFAULT_REPO]: { columnWidths: null } },
    gitBranches: ["main"],
    gitBranchHead: "main",
    remotes: [],
    pushDefault: null,
    commits,
    commitHead: "aaa111",
    avatars: {},
    currentBranches: [],
    currentRepo: DEFAULT_REPO,
    moreCommitsAvailable: true,
    maxCommits: 700,
    showRemoteBranches: true,
    expandedCommit: null,
    columnVisibility: { date: true, author: true, commit: true },
    alwaysAcceptCheckoutCommit: false
  };

  let restoredMock: ReturnType<typeof createVscodeMock>;
  let lineOnBoot: string | null = null;
  let requestedOnBoot: GG.RequestMessage[] = [];

  beforeAll(async () => {
    vi.resetModules();
    restoredMock = createVscodeMock(savedState);
    setupHtml(viewState);
    await import("@/webview/main");
    // Read before anything is dispatched: the restore renders the saved graph
    // during construction, and the previous suite's webview is still listening
    // on `window`.
    lineOnBoot = windowCount();
    receive(branchesResponse);
    requestedOnBoot = restoredMock.sentMessages.filter((m) => m.command === "loadCommits");
  });

  it("comes back with the window the user left it at", () => {
    expect(requestedOnBoot).toMatchObject([{ maxCommits: 700 }]);
  });

  it("shows it, so the widened window is not carried back in silence", () => {
    expect(lineOnBoot).toBe(L.loadedCommitWindow.replace("{0}", "700"));
  });
});
