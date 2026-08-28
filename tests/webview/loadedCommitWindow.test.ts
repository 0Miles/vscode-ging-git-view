import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// The loaded commit window on screen. Widening it is cheap — one press, or a
// held PageDown once automatic loading is on — and it survives every panel
// reload, so it follows the user back. ADR-0019 keeps automatic loading only
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

/** A page the base commit is *not* in — what a shrinking window lands when the
 *  commit holding focus was past the opening count. */
const tipOnly: GitCommitNode[] = [commits[0]];

function commitsResponse(
  moreCommitsAvailable = true,
  loaded: GitCommitNode[] = commits
): GG.ResponseMessage {
  return {
    command: "loadCommits",
    commits: loaded,
    head: "aaa111",
    moreCommitsAvailable,
    hard: true
  };
}

let mock: ReturnType<typeof createVscodeMock>;
// jsdom implements neither scrolling nor scrollTo, so record what the webview
// asks the browser for instead: which elements it brought into view, in order,
// and whether it ever reached for a raw scroll offset.
const scrolledIntoView: Element[] = [];
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

function tabStops() {
  return Array.from(document.querySelectorAll<HTMLElement>('#commitTable [tabindex="0"]'));
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
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledIntoView.push(this);
    };
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

  // The footer has one writer, so what it says cannot drift from what the
  // window actually is. It used to have three: Load More replaced the whole of
  // `btn.parentNode` — which is the footer, not the button — so every press
  // wiped the line for the duration of the load. That is the moment the user
  // most wants it: they just widened the window another page.
  describe("while a Load More page is on its way", () => {
    beforeAll(() => {
      click("loadMoreCommitsBtn");
    });

    it("swaps the button for the spinner but keeps the line and its way back", () => {
      expect(document.getElementById("loadMoreCommitsBtn")).toBeNull();
      expect(document.getElementById("loadingHeader")).not.toBeNull();
      expect(windowCount()).toBe(L.loadedCommitWindow.replace("{0}", "500"));
      expect(document.getElementById("resetLoadedCommitWindowBtn")).not.toBeNull();
    });
  });

  describe("widened until the whole history is in", () => {
    beforeAll(() => {
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

  // The reset is the one path that shrinks the loaded set on purpose, so it is
  // the one redraw whose focus restoration may take the viewport with it. It
  // has to: the page shrinks under the user, the browser clamps them to its new
  // bottom, focus goes back hundreds of rows above that, and the next arrow key
  // scrolls violently to catch up — with automatic loading on, the clamp itself
  // is a scroll event at the threshold and widens the window straight back out.
  // Viewport and focus must not end up contradicting each other.
  describe("resetting it, with focus on a commit the shrunken window keeps", () => {
    let requestedOnPress: GG.RequestMessage[] = [];
    let lineOnPress: string | null = null;

    beforeAll(() => {
      receive(commitsResponse()); // there is more history again
      row("bbb222").focus();
      mock.clearMessages();
      scrollTo.mockClear();
      scrolledIntoView.length = 0;
      click("resetLoadedCommitWindowBtn");
      requestedOnPress = loadCommitsRequests();
      lineOnPress = windowCount();
      receive(commitsResponse());
    });

    it("reloads the graph at the opening count", () => {
      expect(requestedOnPress).toMatchObject([{ maxCommits: 300, hard: true }]);
    });

    it("takes the line with it the moment it presses, not when the page lands", () => {
      // The footer reads `maxCommits`, which the press has already moved. One
      // writer, one reading: the line cannot sit there naming a window the
      // graph is no longer asking for.
      expect(lineOnPress).toBeNull();
      expect(windowLine()).toBeNull();
    });

    it("leaves focus on the same commit, whose row the redraw destroyed", () => {
      expect(document.activeElement).toBe(row("bbb222"));
      expect(tabStops()).toEqual([row("bbb222")]);
    });

    it("brings the viewport to that row, so the two cannot contradict", () => {
      // ADR-0014 read literally: an operation goes back to where the operation
      // was, which is the row holding focus — not the top of the graph, which
      // would leave focus and viewport hundreds of rows apart.
      expect(scrolledIntoView.at(-1)).toBe(row("bbb222"));
    });

    it("moves it by bringing that row into view, never by restoring an offset", () => {
      // ADR-0019: scroll position is not a usable tool here. Writing an offset
      // to cancel out the browser's clamp is compensation, and compensation is
      // what that ADR spent a section refusing.
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  // The same rule every other load entry follows: the whole thing happens or
  // none of it does, because `requestLoadCommits` sends nothing while a load is
  // in flight and the caller cannot undo what it changed first (ADR-0019).
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

  // The other half of the same rule. A window shrinking from 400 to 300 drops
  // whatever sat past 300, focus included, and #73's restoration already
  // declines to move focus somewhere the user never was. The viewport then has
  // no focused row to agree with, so it goes to where the graph now begins —
  // which is also the one place the near-the-bottom threshold cannot fire.
  describe("resetting it, with focus on a commit the shrunken window drops", () => {
    let focusedAfterReset: Element | null = null;

    beforeAll(() => {
      receive(commitsResponse()); // settle the previous reset
      click("loadMoreCommitsBtn"); // widen it again, to 400
      receive(commitsResponse());

      row("bbb222").focus();
      scrollTo.mockClear();
      scrolledIntoView.length = 0;
      click("resetLoadedCommitWindowBtn");
      receive(commitsResponse(true, tipOnly));
      focusedAfterReset = document.activeElement;
    });

    it("drops focus rather than putting it somewhere the user never was", () => {
      expect(document.querySelector('tr.commit[data-hash="bbb222"]')).toBeNull();
      expect(focusedAfterReset).toBe(document.body);
    });

    it("brings the viewport to the row the graph now begins at", () => {
      expect(tabStops()).toEqual([row("aaa111")]);
      expect(scrolledIntoView.at(-1)).toBe(row("aaa111"));
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  // The permission to scroll belongs to the reset's *load*, not to whichever
  // redraw happens to come first. `renderTable` has upstreams that owe nothing
  // to a commit load — a remote list landing, a column toggled — and neither is
  // held back by an in-flight one. Hanging the permission on "the next redraw"
  // loses both ways: that redraw scrolls though the user asked for nothing
  // (ADR-0019), and the reset's own redraw arrives to find it already spent.
  describe("an unrelated redraw arriving while the reset's page is still out", () => {
    let scrolledOnInterloper: Element[] = [];
    let focusedAfterReset: Element | null = null;

    beforeAll(() => {
      receive(commitsResponse()); // settle the previous reset, both commits back
      click("loadMoreCommitsBtn"); // widen it again, to 400
      receive(commitsResponse());

      row("bbb222").focus();
      scrollTo.mockClear();
      scrolledIntoView.length = 0;
      click("resetLoadedCommitWindowBtn");

      // A remote list lands first and re-renders the graph on its own account:
      // branch labels are laid out from the remote names.
      receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
      scrolledOnInterloper = [...scrolledIntoView];

      receive(commitsResponse());
      focusedAfterReset = document.activeElement;
    });

    it("moves nothing on the redraw nobody asked for", () => {
      expect(scrolledOnInterloper).toEqual([]);
    });

    it("still moves the viewport when the reset's own page lands", () => {
      expect(focusedAfterReset).toBe(row("bbb222"));
      expect(scrolledIntoView.at(-1)).toBe(row("bbb222"));
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });
});

// Every time the panel becomes visible again, `webview.html` is reset: a full
// reboot followed by a restore from saved state. Snapping the window back to
// the opening count there would mean "glance at another editor tab and come
// back to a graph that threw the loading away" — a far more frequent version of
// the same complaint, not a cure for it (ADR-0019). The window comes back as
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
