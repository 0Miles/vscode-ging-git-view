import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  makeViewState,
  receive,
  setupHtml
} from "./setup";

// A host query that puts up a progress dialog — "Check for Unmerged Changes",
// the cleanup dialog's opening request, the cleanup deep scan — answers later,
// and the answer is only wanted while that dialog is still the one on screen.
// "Some progress dialog is up" is not that question: once the query's own
// dialog is gone, the next progress dialog the user raises is someone else's,
// and a late answer written into it replaces "Fetching …" with a verdict about
// a branch the user stopped asking about. Each kind already ignores its own
// stale answers by sequence number; what this pins is the crossing between
// kinds, which only the dialog's owner can tell apart.

const L = getWebviewLocalizedStrings();

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
    refs: [{ hash: "bbb222", name: "feature", type: "head" }]
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main", "feature"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: [],
  // Makes "feature" offer the cleanup item on its menu.
  cleanupCandidates: ["feature"]
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

const cleanupPayload: GG.BranchCleanupPayload = {
  candidates: [
    { ref: "feature", isRemote: false, facts: { merged: true, redundant: false, inactive: false } }
  ],
  defaultBranch: "main",
  defaultBranchDate: 1_700_000_000,
  remotesHidden: false,
  scannable: 1
};

let mock: ReturnType<typeof createVscodeMock>;
let cleanupSeq = 0;

function tokenOf(command: string): number {
  const sent = mock.sentMessages.findLast((m) => m.command === command);
  expect(sent, command).toBeDefined();
  return (sent as { token: number }).token;
}

function openMenuOnFeature() {
  document
    .querySelector('#commitTable .gitRef.head[data-name="feature"]')!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

function dialogText() {
  return document.getElementById("dialog")!.textContent ?? "";
}

function dialogIsOpen() {
  return document.getElementById("dialog")!.classList.contains("active");
}

/** Someone else's progress dialog: the toolbar's Fetch. */
function fetchDialogTakesOver() {
  document.getElementById("fetchBtn")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(dialogText()).toContain(L.fetching);
}

function expectFetchDialogUntouched() {
  expect(dialogIsOpen()).toBe(true);
  expect(document.getElementById("actionRunning")!.textContent).toBe(L.fetching + " ...");
}

/** The ways a query's progress dialog leaves the screen without its answer. */
const closeRoutes: [string, () => void][] = [
  [
    "Dismiss",
    () => document.getElementById("dialogDismiss")!.dispatchEvent(new MouseEvent("click"))
  ],
  [
    "Escape",
    () => document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }))
  ],
  [
    "a background reload",
    () => {
      receive({ command: "refresh" });
      receive(branchesResponse);
      receive(commitsResponse);
    }
  ],
  [
    "a host-raised dialog taking the slot",
    () => receive({ command: "copyToClipboard", type: "Commit Hash", success: false })
  ]
];

beforeAll(async () => {
  vi.resetModules();
  mock = createVscodeMock();
  setupHtml(makeViewState({ combineLocalAndRemoteBranchLabels: false }));
  await import("@/webview/main");
  receive(branchesResponse);
  receive(commitsResponse);
});

beforeEach(() => {
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
  mock.clearMessages();
});

describe.each(closeRoutes)("a query's progress dialog closed by %s", (_route, close) => {
  it("keeps the redundancy answer out of the next progress dialog", () => {
    openMenuOnFeature();
    clickItem(L.checkRedundancy);
    const token = tokenOf("branchRedundancy");
    expect(document.getElementById("actionRunning"), "the check's progress dialog").not.toBeNull();

    close();
    fetchDialogTakesOver();
    receive({
      command: "branchRedundancy",
      branch: "feature",
      result: { kind: "unknown", reason: "noMergeBase" },
      token
    });

    expectFetchDialogUntouched();
  });

  it("keeps the cleanup opening answer out of the next progress dialog", () => {
    openMenuOnFeature();
    clickItem(L.cleanupMenuItem);
    const token = tokenOf("branchCleanupOpen");
    expect(
      document.getElementById("actionRunning"),
      "the cleanup's progress dialog"
    ).not.toBeNull();

    close();
    fetchDialogTakesOver();
    receive({ command: "branchCleanupOpen", payload: cleanupPayload, fetchFailed: false, token });

    expectFetchDialogUntouched();
  });

  it("keeps the deep scan's progress out of the next progress dialog", () => {
    receive({
      command: "showBranchCleanup",
      repo: DEFAULT_REPO,
      seq: ++cleanupSeq,
      payload: cleanupPayload
    });
    document.getElementById("cleanupDeepCheck")!.dispatchEvent(new MouseEvent("click"));
    const token = tokenOf("branchCleanupScan");

    close();
    fetchDialogTakesOver();
    receive({ command: "branchCleanupScanProgress", token, done: 3, total: 7 });

    expectFetchDialogUntouched();
  });
});

// The other side of the same check: the answer still lands while its own dialog
// is up, which is the whole reason the query raised one.
describe("a query whose progress dialog is still up", () => {
  it("shows the redundancy answer", () => {
    openMenuOnFeature();
    clickItem(L.checkRedundancy);
    receive({
      command: "branchRedundancy",
      branch: "feature",
      result: { kind: "unknown", reason: "noMergeBase" },
      token: tokenOf("branchRedundancy")
    });

    expect(document.getElementById("actionRunning")).toBeNull();
    expect(dialogIsOpen()).toBe(true);
  });

  it("opens the cleanup dialog on its answer", () => {
    openMenuOnFeature();
    clickItem(L.cleanupMenuItem);
    receive({
      command: "branchCleanupOpen",
      payload: cleanupPayload,
      fetchFailed: false,
      token: tokenOf("branchCleanupOpen")
    });

    expect(document.querySelector('#dialog .cleanupRow input[data-ref="feature"]')).not.toBeNull();
  });

  it("counts the deep scan's progress", () => {
    receive({
      command: "showBranchCleanup",
      repo: DEFAULT_REPO,
      seq: ++cleanupSeq,
      payload: cleanupPayload
    });
    document.getElementById("cleanupDeepCheck")!.dispatchEvent(new MouseEvent("click"));
    receive({
      command: "branchCleanupScanProgress",
      token: tokenOf("branchCleanupScan"),
      done: 3,
      total: 7
    });

    expect(document.getElementById("actionRunning")!.textContent).toBe(
      L.cleanupScanning.replace("{0}", "3").replace("{1}", "7")
    );
  });
});
