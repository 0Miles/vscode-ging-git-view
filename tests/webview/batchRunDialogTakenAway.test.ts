import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// A batch run's retry offer is a question, and until #125 it was a question with
// exactly two exits: Yes and Cancel, both hanging off one dialog. The dialog is
// a single slot that any background message may write over, and an overwrite
// runs neither exit. The run stayed in `offeringRetry` for the life of the
// panel, and every later batch action was refused as busy — so the batch feature
// died in that panel until the tab was reopened. That "for the life of the
// panel" is the symptom the ticket leads with, so it is asserted here rather
// than left to emerge from the suite sharing one panel.
//
// The fix is two mechanisms, and this suite keeps them apart on purpose:
//
//   `abandon()` is the primary one. The route that knows the offer is gone ends
//   the run and keeps what round 1 did until there is a screen to say it on.
//   The dialog that displaced the offer wins the screen — it is a request the
//   user made and the host has already taken it off its queue — so the summary
//   is owed rather than shown, and lands when the slot next frees.
//
//   `start()` reading a standing `offeringRetry` as an ended run is the
//   backstop, for the destruction route that forgets to call `abandon()`. The
//   offer has at least eight of them. It is reached below by taking the mark off
//   the offer's dialog, which is exactly what such an omission would look like
//   from the state machine's side.
//
// The last test is the case the ruling asked to be decided: reaching for a
// second batch while the offer is still on screen. The gesture is reachable
// (#127, #141), the arrival is not — every batch action that reaches `BatchRun`
// is one that asks (ADR-0009), so it raises its own question first, and raising
// it is what takes the offer away.

const L = getWebviewLocalizedStrings();

const viewState = makeViewState({ combineLocalAndRemoteBranchLabels: false });

const commits: GitCommitNode[] = [
  {
    hash: "head1",
    parentHashes: ["base1"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000100,
    message: "On main",
    refs: [{ hash: "head1", name: "main", type: "head" }]
  },
  {
    hash: "base1",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Base",
    refs: [
      { hash: "base1", name: "feature-a", type: "head" },
      { hash: "base1", name: "feature-b", type: "head" }
    ]
  }
];

function dialogText(): string {
  return document.getElementById("dialog")!.textContent ?? "";
}

function confirmDialog() {
  document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
}

function dismissDialog() {
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
}

/** Let the microtask that delivers an owed summary run. Queued from
 *  `hideDialog`, so it is already ahead of this continuation in the queue. */
function flushMicrotasks() {
  return Promise.resolve();
}

function loadBranches() {
  receive({
    command: "loadBranches",
    branches: ["main", "feature-a", "feature-b"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
}

function loadCommits() {
  receive({
    command: "loadCommits",
    commits,
    head: "head1",
    moreCommitsAvailable: false,
    hard: true
  });
}

/** Answer a reload in flight. An ended batch run kicks one off, and delegated
 *  actions queue behind it, so the view has to settle before the next message
 *  is delivered — otherwise it waits instead of raising its dialog. */
function settleRefresh() {
  loadBranches();
  loadCommits();
}

let seq = 0;
function receiveBatchDelete(targets: string[]) {
  receive({
    command: "runRefBatchAction",
    repo: DEFAULT_REPO,
    action: "delete",
    targets,
    skipped: [],
    seq: ++seq
  });
}

function receiveDelegatedRename() {
  receive({
    command: "runRefAction",
    repo: DEFAULT_REPO,
    ref: "feature-a",
    action: "rename",
    seq: ++seq
  });
}

/**
 * The destruction route the ticket names, driven end to end.
 *
 * A delegated action that arrives while a load is in flight is held on
 * `pendingRefAction`, and `triggerLoadCommitsCallback` retries it after *every*
 * commit load completes. So the dialog does not arrive at a moment anything in
 * the webview chose — it arrives the instant a background load lands, which is
 * what makes this ordinary rather than exotic.
 */
function delegatedActionLandsWithABackgroundLoad() {
  loadBranches(); // a background reload's branch half; its commit half follows
  receiveDelegatedRename(); // held: a load is in flight
  loadCommits(); // lands -> triggerLoadCommitsCallback -> tryRunPendingRefAction
}

/** Drive one batch delete as far as its retry offer: round 1 confirmed, and one
 *  ref refused in the way a force round can fix. */
function offerRetry() {
  receiveBatchDelete(["feature-a", "feature-b"]);
  confirmDialog();
  receive({
    command: "deleteBranches",
    results: [
      { ref: "feature-a", status: null, notFullyMerged: false },
      { ref: "feature-b", status: "error: not fully merged", notFullyMerged: true }
    ]
  });
  expect(dialogText()).toContain("not fully merged");
}

/** One whole batch delete that succeeds, from delegation to summary. Returns
 *  whether the round-1 request actually went out. */
function runOneCleanBatch(mock: ReturnType<typeof createVscodeMock>, ref: string): boolean {
  mock.clearMessages();
  receiveBatchDelete([ref]);
  confirmDialog();
  const sent = mock.sentMessages.some((m) => m.command === "deleteBranches");
  if (sent) {
    receive({ command: "deleteBranches", results: [{ ref, status: null, notFullyMerged: false }] });
    settleRefresh();
  }
  return sent;
}

describe("a batch retry offer whose dialog is taken away", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    loadBranches();
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    loadCommits();
  });

  beforeEach(() => {
    mock.clearMessages();
  });

  it("gives the displacing dialog the screen and pays the summary back afterwards", async () => {
    offerRetry();
    mock.clearMessages();

    delegatedActionLandsWithABackgroundLoad();

    // The offer is gone, and the delegated action holds the screen: the host
    // has already taken it off `pendingRefAction`, so writing over it would
    // lose a request the user made outright.
    expect(dialogText()).not.toContain("not fully merged");
    expect(dialogText()).toContain(L.renameBranch);
    // The graph is put right at the moment the run ends — it can show which
    // branches went, though never why the rest stayed.
    expect(mock.sentMessages.some((m) => m.command === "loadBranches")).toBe(true);

    // The summary is owed, not dropped. It arrives once the slot is free.
    dismissDialog();
    await flushMicrotasks();
    expect(dialogText()).toContain("1 succeeded, 1 failed");
    expect(dialogText()).toContain("feature-b");

    dismissDialog();
    settleRefresh();
  });

  it("holds the owed summary back while the freed slot is claimed again", async () => {
    offerRetry();

    // A batch confirmation displaces the offer this time, and answering it
    // closes that dialog and raises a progress dialog in the same breath — so
    // the slot is emptied but never actually free. A summary that jumped in
    // here would be writing over a dialog again, which is the thing this ticket
    // is about.
    receiveBatchDelete(["feature-a"]);
    settleRefresh();
    confirmDialog();
    await flushMicrotasks();
    expect(dialogText()).not.toContain("1 succeeded, 1 failed");
    expect(dialogText()).toContain(L.deletingBranches);

    // Still owed, and delivered at the first close that leaves the slot empty —
    // here the reload that closes the progress dialog it was waiting on.
    receive({
      command: "deleteBranches",
      results: [{ ref: "feature-a", status: null, notFullyMerged: false }]
    });
    settleRefresh();
    await flushMicrotasks();
    expect(dialogText()).toContain("1 succeeded, 1 failed");
    expect(dialogText()).toContain("feature-b");

    dismissDialog();
    settleRefresh();
  });

  it("recovers through the backstop when a destruction route forgets the hook", () => {
    offerRetry();

    // What an omission looks like from the state machine's side: the offer's
    // dialog is destroyed, but the route that destroyed it never told the run.
    // Taking the mark off is the smallest faithful way to stage that — the
    // dialog is still overwritten below, and `abandon()` is simply not reached.
    document.getElementById("batchRetryOffer")!.removeAttribute("id");
    delegatedActionLandsWithABackgroundLoad();
    dismissDialog();
    settleRefresh();

    // The run is still sitting in `offeringRetry` with nobody able to answer
    // it. `start()` is the only guard left, and it is enough.
    mock.clearMessages();
    receiveBatchDelete(["feature-a", "feature-b"]);
    confirmDialog();
    expect(dialogText()).not.toContain(L.dialogBatchBusy);
    expect(mock.sentMessages.find((m) => m.command === "deleteBranches")).toMatchObject({
      refs: ["feature-a", "feature-b"]
    });

    // And the run it let through is a clean one: its own retry round folds into
    // its own summary, with nothing of the abandoned run's round 1 in it.
    receive({
      command: "deleteBranches",
      results: [
        { ref: "feature-a", status: "error: not fully merged", notFullyMerged: true },
        { ref: "feature-b", status: null, notFullyMerged: false }
      ]
    });
    confirmDialog(); // force round for feature-a
    receive({
      command: "deleteBranches",
      results: [{ ref: "feature-a", status: "error: still not fully merged", notFullyMerged: true }]
    });
    expect(dialogText()).toContain("1 succeeded, 1 failed");
    expect(dialogText()).toContain("feature-a");
    dismissDialog();
    settleRefresh();
  });

  it("leaves the panel able to run batches for the rest of its life", () => {
    offerRetry();
    delegatedActionLandsWithABackgroundLoad();
    dismissDialog();
    settleRefresh();

    // The ticket's symptom is not "the next batch fails", it is that the panel
    // never works again. Three in a row, each going out on the wire.
    expect(runOneCleanBatch(mock, "feature-a")).toBe(true);
    expect(runOneCleanBatch(mock, "feature-b")).toBe(true);
    expect(runOneCleanBatch(mock, "feature-a")).toBe(true);
  });

  it("is taken away by the second batch's own question, not refused as busy", () => {
    offerRetry();

    // A second batch cannot reach `start()` with the offer still standing: it
    // asks its own question first, and that question is what takes the offer
    // away — which is why no guard for that case exists in `startBatchRun`.
    receiveBatchDelete(["feature-a"]);
    expect(dialogText()).not.toContain("not fully merged");
    expect(dialogText()).toContain(L.deleteBranches);
    settleRefresh();

    mock.clearMessages();
    confirmDialog();
    expect(dialogText()).not.toContain(L.dialogBatchBusy);
    expect(mock.sentMessages.find((m) => m.command === "deleteBranches")).toMatchObject({
      refs: ["feature-a"]
    });
    receive({
      command: "deleteBranches",
      results: [{ ref: "feature-a", status: null, notFullyMerged: false }]
    });
    settleRefresh();
  });
});
