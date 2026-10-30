import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// The busy indicator on the Refresh button is one class driven by a count
// (`busyLoads`), and four things raise a claim on it: a refresh, a
// branch-change reload, a Find step that has to page, and a Repository Setting
// that reloads the commits. Each claim has to be dropped exactly once on every
// way its load can end. droppedLoadRequests and navigationDuringLoad pin the
// ways a request can be dropped or abandoned; repoSettingsDrawer pins its own
// reload. This file pins what was left: the ordinary end of the paths no test
// walked, and the ends nobody planned for — a handler, or a load's own
// close-out, throwing part-way through.
//
// A throw is reported and swallowed at the message listener (ADR-0016), so the
// panel lives on after one. What it must not live on with is a load callback
// still set: that is the panel's one-load-at-a-time gate shut for good, and
// every later refresh dropped onto a load that is never coming.
//
// One webview is booted for the whole file and the scenarios run in order;
// re-importing per scenario would leave the previous instance listening on
// `window`.

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
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  // More is available, so the footer offers Load More.
  moreCommitsAvailable: true,
  hard: true
};

const MERGED: GG.CleanupCandidateFacts = { merged: true, redundant: false, inactive: false };

const cleanupPayload: GG.BranchCleanupPayload = {
  candidates: [{ ref: "merged", isRemote: false, facts: MERGED }],
  defaultBranch: "main",
  defaultBranchDate: 1_700_000_000,
  remotesHidden: false,
  // Non-zero, or the dialog has no deep-check button to press.
  scannable: 1
};

let mock: ReturnType<typeof createVscodeMock>;
let cleanupSeq = 0;

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function sentOf(command: GG.RequestMessage["command"]) {
  return mock.sentMessages.filter((m) => m.command === command);
}

function refreshing() {
  return document.getElementById("refreshBtn")!.classList.contains("refreshing");
}

function progressDialogIsUp() {
  return document.getElementById("actionRunning") !== null;
}

function reportedCommands() {
  return mock.sentMessages
    .filter((m): m is GG.RequestReportError => m.command === "reportError")
    .map((m) => m.report.command);
}

function savedMaxCommits() {
  return mock.getState()!.maxCommits;
}

/** The token on the newest branch-index request. Answers have to carry it or
 *  the webview discards them as superseded. */
function latestBranchSearchToken() {
  const requests = sentOf("branchSearch");
  expect(requests.length).toBeGreaterThan(0);
  return (requests[requests.length - 1] as Extract<GG.RequestMessage, { command: "branchSearch" }>)
    .token;
}

/** Make the host bridge throw on one command, the way a dismissal hook or a
 *  close-out would if anything in it failed. Everything else still goes out —
 *  `reportError` included, which is how the throw is seen to have been
 *  reported rather than swallowed. */
function throwOnSending(command: GG.RequestMessage["command"]) {
  const api = acquireVsCodeApi();
  const post = api.postMessage.bind(api);
  return vi.spyOn(api, "postMessage").mockImplementation((msg) => {
    if (msg.command === command) throw new Error(command + " failed");
    post(msg);
  });
}

/** Put the Branch Cleanup deep scan's progress dialog up. It is the one
 *  reload-owned overlay with a dismissal hook that talks to the host, so it is
 *  how a load's close-out comes to run code that can fail. */
function startCleanupScan() {
  receive({
    command: "showBranchCleanup",
    repo: DEFAULT_REPO,
    seq: ++cleanupSeq,
    payload: cleanupPayload
  });
  click("cleanupDeepCheck");
  expect(progressDialogIsUp(), "the scan never raised its progress dialog").toBe(true);
}

/** A refresh, answered in full. */
function refreshLands() {
  click("refreshBtn");
  receive(branchesResponse);
  receive(commitsResponse);
}

beforeAll(async () => {
  vi.resetModules();
  mock = createVscodeMock();
  setupHtml(viewState);
  await import("@/webview/main");
  receive(branchesResponse);
  receive(commitsResponse);
});

describe("a Find step that has to page", () => {
  let windowBefore = 0;
  let pageRequests: unknown[] = [];
  let spinningWhilePaging = false;

  beforeAll(() => {
    click("findBtn");
    windowBefore = savedMaxCommits();
    // A branch match just past the loaded window — under the size that asks
    // first, so the step loads at once.
    const nearBranch = {
      ref: "feature/recent",
      name: "feature/recent",
      hash: "recent999",
      logDepth: windowBefore + 49
    };
    const input = <HTMLInputElement>document.getElementById("findInput");
    input.value = "recent";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "t" }));
    receive({
      command: "branchSearch",
      token: latestBranchSearchToken(),
      status: null,
      branches: [nearBranch]
    });
    mock.clearMessages();
    // Enter on a branch hit revalidates the index first, so the page is asked
    // for when that answer lands.
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    receive({
      command: "branchSearch",
      token: latestBranchSearchToken(),
      status: null,
      branches: [nearBranch]
    });
    pageRequests = sentOf("loadCommits");
    spinningWhilePaging = refreshing();
    receive(commitsResponse);
  });

  it("asks for the page that reaches the match", () => {
    expect(pageRequests).toMatchObject([{ maxCommits: windowBefore + 50 }]);
  });

  it("spins the Refresh button while that page is out", () => {
    expect(spinningWhilePaging).toBe(true);
  });

  it("stops spinning when the page lands", () => {
    expect(refreshing()).toBe(false);
  });
});

// The close-out's rule is "hard, or branches changed, or commits changed", and
// this is the arm the others hide: a soft refresh whose branch half finds
// nothing new, whose commit half does.
describe("a soft refresh where only the commits changed", () => {
  let dialogUpBefore = false;
  let spinningWhileLoading = false;

  beforeAll(() => {
    click("fetchBtn"); // the progress dialog a change is supposed to take down
    dialogUpBefore = progressDialogIsUp();
    receive({ command: "refresh" }); // the file watcher's own, soft
    spinningWhileLoading = refreshing();
    receive({ ...branchesResponse, hard: false }); // same branches, same HEAD
    receive({
      ...commitsResponse,
      hard: false,
      // A tag landed on the base commit: the branch list cannot see it.
      commits: [commits[0], { ...commits[1], refs: [{ hash: "bbb222", name: "v1", type: "tag" }] }]
    });
  });

  it("had the progress dialog up and the button spinning", () => {
    expect(dialogUpBefore).toBe(true);
    expect(spinningWhileLoading).toBe(true);
  });

  it("stops spinning when it finishes", () => {
    expect(refreshing()).toBe(false);
  });

  it("dismisses the progress dialog on the strength of the commits alone", () => {
    expect(progressDialogIsUp()).toBe(false);
  });
});

describe("a refresh told its repo is gone, with nothing else out", () => {
  let spinningWhileLoading = false;

  beforeAll(() => {
    mock.clearMessages();
    click("refreshBtn");
    spinningWhileLoading = refreshing();
    receive({ ...branchesResponse, isRepo: false });
  });

  it("spun while it was out", () => {
    expect(spinningWhileLoading).toBe(true);
  });

  it("stops spinning there and then: its claim was the last one", () => {
    expect(refreshing()).toBe(false);
  });

  it("goes back to the host for the repo list instead of paging", () => {
    expect(sentOf("loadRepos")).toHaveLength(1);
    expect(sentOf("loadCommits")).toHaveLength(0);
  });
});

describe("when something throws part-way through a load", () => {
  beforeAll(() => {
    // Reported through the console as well as to the host; keep it quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("the branch handler", () => {
    let commitRequests: unknown[] = [];
    let spinningAfterTheThrow = false;
    let reported: (string | null)[] = [];

    beforeAll(() => {
      mock.clearMessages();
      click("refreshBtn");
      receive({ ...branchesResponse, branches: null } as unknown as GG.ResponseMessage);
      reported = reportedCommands();
      commitRequests = sentOf("loadCommits");
      spinningAfterTheThrow = refreshing();
      receive(commitsResponse);
    });

    it("is still reported to the host", () => {
      expect(reported).toEqual(["loadBranches"]);
    });

    it("hands the reload on to its commit half, as a branch list with no changes", () => {
      expect(commitRequests).toHaveLength(1);
      expect(spinningAfterTheThrow).toBe(true);
    });

    it("stops spinning when that half lands", () => {
      expect(refreshing()).toBe(false);
    });

    it("leaves the branch gate open for the next refresh", () => {
      mock.clearMessages();
      refreshLands();
      expect(sentOf("loadBranches")).toHaveLength(1);
      expect(refreshing()).toBe(false);
    });
  });

  // The early way out of the commit handler — an answer that looks the same as
  // what is drawn — sits ahead of the try/finally that guards the redraw.
  describe("the commit handler, on its nothing-changed path", () => {
    let reported: (string | null)[] = [];

    beforeAll(() => {
      click("refreshBtn");
      receive(branchesResponse);
      mock.clearMessages();
      receive({
        ...commitsResponse,
        hard: false,
        commits: [{ ...commits[0], refs: null }, commits[1]]
      } as unknown as GG.ResponseMessage);
      reported = reportedCommands();
    });

    it("is still reported to the host", () => {
      expect(reported).toEqual(["loadCommits"]);
    });

    it("stops spinning", () => {
      expect(refreshing()).toBe(false);
    });

    it("leaves the commit gate open for the next refresh", () => {
      mock.clearMessages();
      click("refreshBtn");
      receive(branchesResponse);
      expect(sentOf("loadCommits")).toHaveLength(1);
      receive(commitsResponse);
      expect(refreshing()).toBe(false);
    });
  });

  describe("a refresh's close-out, from its commit half", () => {
    let reported: (string | null)[] = [];
    let spinningAfterTheThrow = true;

    beforeAll(() => {
      startCleanupScan();
      const bridge = throwOnSending("branchCleanupScanCancel");
      mock.clearMessages();
      refreshLands();
      reported = reportedCommands();
      spinningAfterTheThrow = refreshing();
      bridge.mockRestore();
    });

    it("is still reported to the host", () => {
      expect(reported).toEqual(["loadCommits"]);
    });

    it("stops spinning", () => {
      expect(spinningAfterTheThrow).toBe(false);
    });

    it("leaves the commit gate open for the next refresh", () => {
      mock.clearMessages();
      click("refreshBtn");
      receive(branchesResponse);
      expect(sentOf("loadCommits")).toHaveLength(1);
      receive(commitsResponse);
      expect(refreshing()).toBe(false);
    });
  });

  // The branch callback closes out the reload itself when its commit request
  // is dropped onto a load already out — here, a Load More page.
  describe("a refresh's close-out, from its branch half", () => {
    let commitRequestDropped = false;
    let reported: (string | null)[] = [];
    let spinningWithThePageOut = false;

    beforeAll(() => {
      startCleanupScan();
      const bridge = throwOnSending("branchCleanupScanCancel");
      click("loadMoreCommitsBtn");
      mock.clearMessages();
      click("refreshBtn");
      receive(branchesResponse);
      commitRequestDropped = sentOf("loadCommits").length === 0;
      reported = reportedCommands();
      spinningWithThePageOut = refreshing();
      bridge.mockRestore();
      receive(commitsResponse); // the Load More page lands
    });

    it("had its commit request dropped onto the page in flight", () => {
      expect(commitRequestDropped).toBe(true);
    });

    it("is still reported to the host", () => {
      expect(reported).toEqual(["loadBranches"]);
    });

    it("drops only its own claim: the page claims none", () => {
      expect(spinningWithThePageOut).toBe(false);
      expect(refreshing()).toBe(false);
    });

    it("leaves the branch gate open for the next refresh", () => {
      mock.clearMessages();
      refreshLands();
      expect(sentOf("loadBranches")).toHaveLength(1);
      expect(refreshing()).toBe(false);
    });
  });
});
