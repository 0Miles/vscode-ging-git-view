import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// At most one commit load is ever in flight, and `requestLoadCommits` drops any
// request that arrives while one is (ADR-0018 declined queueing it, because
// delegated ref actions schedule themselves off that invariant). The callers
// here are the ones that used to change state first and discover the drop
// afterwards, leaving the view describing a load that never happened. Load
// More — the remaining caller — is covered in loadMoreCommits.test.ts.
//
// The branch load has the same shape one level out: a dropped `loadBranches`
// takes the whole reload with it, callback included.
//
// One webview is booted for the whole suite and the scenarios run in order,
// the way a session actually unfolds; re-importing the module per scenario
// would leave the previous instance still listening on `window`.

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

let mock: ReturnType<typeof createVscodeMock>;

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function sentOf(command: GG.RequestMessage["command"]) {
  return mock.sentMessages.filter((m) => m.command === command);
}

/** Pick a commit ordering from the column-header context menu. */
function chooseCommitOrder(label: string) {
  document
    .querySelector<HTMLElement>('th[data-col="date"]')!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => li.querySelector(".contextMenuItemLabel")?.textContent?.trim() === label);
  expect(item, label).not.toBeNull();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function refreshing() {
  return document.getElementById("refreshBtn")!.classList.contains("refreshing");
}

function actionDialogUp() {
  return document.getElementById("actionRunning") !== null;
}

/** The branch-filter chip's label — the toolbar's only outward sign of which
 *  branches the graph is showing. */
function filterChipText() {
  return document.getElementById("branchFilterText")!.textContent;
}

describe("a commit load request arriving while one is in flight", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
  });

  describe("from the commit-ordering menu", () => {
    beforeAll(() => {
      // Find open, so the branch search index exists and can be observed.
      click("findBtn");
      // Widen the loaded commit window to 400 and leave that load in flight.
      click("loadMoreCommitsBtn");
      mock.clearMessages();
      chooseCommitOrder(L.commitOrderAuthorDate);
    });

    it("does not persist the preference", () => {
      expect(sentOf("saveRepoState")).toHaveLength(0);
    });

    it("does not reload the graph", () => {
      expect(sentOf("loadCommits")).toHaveLength(0);
    });

    describe("and once the in-flight load lands", () => {
      beforeAll(() => {
        receive(commitsResponse);
      });

      it("leaves the branch search index standing", () => {
        // Invalidating the index bumps the token stamped on every branchSearch
        // request (that is how the host discards answers to superseded ones).
        // The post-load request carrying token 2 — the one after the token 1
        // that opening Find sent — shows nothing was invalidated in between.
        expect(sentOf("branchSearch")).toMatchObject([{ token: 2 }]);
      });

      it("leaves the loaded commit window where Load More left it", () => {
        mock.clearMessages();
        click("loadMoreCommitsBtn");
        // 500, not 400: the window still stands at the 400 the earlier press
        // reached. Snapping it back to the opening 300 would have made this
        // press ask for 400 — and the shrunken window would have silently
        // collapsed the graph at some later refresh.
        expect(sentOf("loadCommits")).toMatchObject([{ maxCommits: 500 }]);
      });
    });
  });

  describe("from a refresh", () => {
    let spinningWhileLoading = false;
    let dialogUpWhileLoading = false;

    beforeAll(() => {
      receive(commitsResponse); // settle the previous press
      // Fetch raises the action-running dialog that the refresh following the
      // action is supposed to dismiss.
      click("fetchBtn");
      // A Load More page is in flight; its callback has no interest in either
      // the Refresh button or the dialog, so nothing but the refresh itself
      // can clear them.
      click("loadMoreCommitsBtn");
      click("refreshBtn");
      spinningWhileLoading = refreshing();
      dialogUpWhileLoading = actionDialogUp();
      receive(branchesResponse); // the branches half lands, the commits half is dropped
    });

    it("spins the Refresh button while the refresh is under way", () => {
      expect(spinningWhileLoading).toBe(true);
    });

    it("holds the action-running dialog up while the action is under way", () => {
      expect(dialogUpWhileLoading).toBe(true);
    });

    it("stops spinning when the inner commit load is dropped", () => {
      expect(refreshing()).toBe(false);
    });

    it("dismisses the action-running dialog when the inner commit load is dropped", () => {
      // The dropped callback owned this too. Leaving it standing strands the
      // user behind an overlay whose only remaining exit is the Escape key.
      expect(actionDialogUp()).toBe(false);
    });
  });

  describe("from a branch-filter change pushed by the Branches side-view", () => {
    let chipBefore: string | null = null;

    beforeAll(() => {
      receive(commitsResponse); // settle the previous refresh
      chipBefore = filterChipText();
      // Widen the loaded commit window to 700 and leave that load in flight.
      click("loadMoreCommitsBtn");
      mock.clearMessages();
      receive({ command: "setBranchFilter", branches: ["feature/x"] });
    });

    it("does not reload the graph", () => {
      expect(sentOf("loadCommits")).toHaveLength(0);
    });

    it("still applies the filter — a host push has no retry and must not vanish", () => {
      // Only the reload is dropped. Refusing the push outright would leave the
      // side-view showing a filter the graph never heard of, with nothing to
      // correct it; the graph catches up on the next load instead.
      expect(chipBefore).toBe("");
      expect(filterChipText()).toBe("feature/x");
    });

    it("leaves the Refresh button alone rather than spinning it forever", () => {
      expect(refreshing()).toBe(false);
    });

    describe("and once the in-flight load lands", () => {
      beforeAll(() => {
        receive(commitsResponse);
        mock.clearMessages();
        click("loadMoreCommitsBtn");
      });

      it("leaves the loaded commit window where Load More left it", () => {
        // 800, not 400: applying the change would have snapped the window back
        // to the opening 300 for a graph that never reloaded.
        expect(sentOf("loadCommits")).toMatchObject([{ maxCommits: 800 }]);
      });
    });
  });

  describe("and the branch load itself, when a refresh finds one already out", () => {
    let spinningWhileLoading = false;

    beforeAll(() => {
      receive(commitsResponse); // settle the previous press
      click("refreshBtn"); // branches requested, deliberately unanswered
      spinningWhileLoading = refreshing();
      mock.clearMessages();
      click("refreshBtn"); // this one's branches request is dropped
    });

    it("spins the Refresh button while the first refresh is under way", () => {
      expect(spinningWhileLoading).toBe(true);
    });

    it("sends no second branch request", () => {
      expect(sentOf("loadBranches")).toHaveLength(0);
    });

    it("stops spinning rather than leaving an indicator nothing can clear", () => {
      // The dropped request takes the callback — and with it the only path
      // that would ever have switched the indicator back off — so the caller
      // has to close out what it switched on.
      expect(refreshing()).toBe(false);
    });
  });
});
