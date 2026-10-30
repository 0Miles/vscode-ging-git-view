import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickId,
  createVscodeMock,
  DEFAULT_REPO,
  dialogShown,
  dialogText,
  makeViewState,
  receive,
  setupHtml
} from "./setup";

// A host answer that raises a dialog of its own — an action's error, a failed
// request's error, tag details, the force-delete offer, a batch's retry offer
// or summary — can land after the user has opened another dialog. ADR-0019
// named the missing guard (#243): `showDialog` writes over whatever is up and
// runs no hook for it, so the question the user was reading went with its
// answers. The answers that are owner-checked (#127: Check for Unmerged
// Changes, the cleanup dialog's requests) were never the problem; these, which
// had no owner to check, were.
//
// The rule pinned here is the one the reload already lives by
// (`hideReloadOwnedOverlays`): a progress dialog is the webview narrating a
// wait, and an answer replaces it as it always has; any other dialog is the
// user's, and the answer is owed until the slot frees, behind whatever else is
// owed.

const L = getWebviewLocalizedStrings();
const OTHER_REPO = "/workspace/repo-b";

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
    refs: [
      { hash: "bbb222", name: "feature-a", type: "head" },
      { hash: "bbb222", name: "feature-b", type: "head" }
    ]
  }
];

/** Let the microtask that pays an owed dialog run. */
const flushMicrotasks = () => Promise.resolve();

function settleRefresh() {
  receive({
    command: "loadBranches",
    token: 0,
    branches: ["main", "feature-a", "feature-b"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: "aaa111",
    moreCommitsAvailable: false,
    hard: true
  });
}

let seq = 0;
/** Put a question of the user's own on screen: the rename form a delegated
 *  rename raises. Returns its text, to tell it apart from what may replace it. */
function openUsersQuestion(): string {
  receive({
    command: "runRefAction",
    repo: DEFAULT_REPO,
    ref: "feature-a",
    action: "rename",
    seq: ++seq
  });
  expect(dialogText()).toContain(L.renameBranch);
  return dialogText();
}

function dismiss() {
  clickId("dialogDismiss");
}

describe("a host answer arriving over a dialog of the user's", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(
      makeViewState({
        combineLocalAndRemoteBranchLabels: false,
        repos: { [DEFAULT_REPO]: { columnWidths: null }, [OTHER_REPO]: { columnWidths: null } }
      })
    );
    await import("@/webview/main");
    settleRefresh();
  });

  /** Dismiss whatever is up, and whatever was owed behind it. */
  async function closeEverything(): Promise<void> {
    if (!dialogShown() || document.getElementById("dialogDismiss") === null) return;
    dismiss();
    await flushMicrotasks();
    return closeEverything();
  }

  beforeEach(async () => {
    // Every scenario starts from an empty slot with nothing owed.
    await closeEverything();
    expect(dialogShown()).toBe(false);
    // An error's Dismiss refreshes, and a delegated action waits for that.
    settleRefresh();
  });

  it("still replaces the action's own progress dialog at once", () => {
    clickId("fetchBtn");
    expect(document.getElementById("actionRunning")).not.toBeNull();

    receive({ command: "fetch", status: "fatal: unable to access remote" });

    expect(dialogText()).toContain(L.unableToFetch);
  });

  it("waits behind the user's question when it is an action's failure", async () => {
    // The progress dialog has a Dismiss, and dismissing it does not stop the
    // fetch: the user is free to ask for something else meanwhile.
    clickId("fetchBtn");
    dismiss();
    const question = openUsersQuestion();

    receive({ command: "fetch", status: "fatal: unable to access remote" });

    expect(dialogText()).toBe(question);
    dismiss();
    await flushMicrotasks();
    expect(dialogText()).toContain(L.unableToFetch);
    expect(dialogText()).toContain("fatal: unable to access remote");
  });

  const requestAnswers: [string, GG.ResponseMessage, string][] = [
    [
      "a copy that failed",
      { command: "copyToClipboard", type: "Commit Hash", success: false },
      L.unableToCopyToClipboard.replace("{0}", L.typeCommitHash)
    ],
    ["tag details that failed", { command: "tagDetails", details: null }, L.unableToLoadTagDetails],
    [
      "tag details",
      {
        command: "tagDetails",
        details: {
          tagHash: "tag111",
          commitHash: "aaa111",
          name: "Alice",
          email: "",
          date: null,
          message: "Release one",
          signatureStatus: ""
        }
      },
      "Release one"
    ],
    [
      "commit details that failed",
      { command: "commitDetails", commitDetails: null },
      L.unableToLoadCommitDetails
    ],
    [
      "an archive that failed",
      { command: "createArchive", success: false },
      L.unableToCreateArchive
    ],
    ["a patch that failed", { command: "exportPatch", success: false }, L.unableToExportPatch],
    ["a diff that failed", { command: "viewDiff", success: false }, L.unableToViewDiff],
    ["a file that failed to open", { command: "openFile", success: false }, L.unableToOpenFile],
    [
      "a comparison that failed",
      { command: "compareCommits", fromHash: "aaa111", toHash: "bbb222", fileChanges: null },
      L.unableToLoadCommitDetails
    ],
    [
      "a revision that failed to open",
      { command: "viewFileAtRevision", success: false },
      L.unableToOpenFile
    ],
    [
      "a diff with the working tree that failed",
      { command: "viewDiffWithWorking", success: false },
      L.unableToViewDiff
    ]
  ];

  it.each(requestAnswers)(
    "waits behind the user's question when it is %s",
    async (_, msg, shows) => {
      const question = openUsersQuestion();

      receive(msg);

      expect(dialogText()).toBe(question);
      dismiss();
      await flushMicrotasks();
      expect(dialogText()).toContain(shows);
    }
  );

  it("waits behind the user's question when it is the force-delete offer", async () => {
    receive({
      command: "runRefAction",
      repo: DEFAULT_REPO,
      ref: "feature-b",
      action: "delete",
      seq: ++seq
    });
    clickId("dialogAction");
    const question = openUsersQuestion();

    receive({ command: "deleteBranch", status: "error: not fully merged", notFullyMerged: true });

    expect(dialogText()).toBe(question);
    dismiss();
    await flushMicrotasks();
    expect(document.getElementById("dialogAction")!.textContent).toBe(L.dialogYes);
    expect(dialogText()).toContain("feature-b");
    dismiss();
    settleRefresh();
  });

  // Owing stretches a wait from one round-trip to however long the user's
  // question stands, and the panel can follow Source Control onto another
  // repository meanwhile. None of these dialogs names its repository — the
  // force-delete offer's Yes would even delete in the one the refused delete
  // went to — so, paid after the panel has moved, each would read as being
  // about the repository on screen. They are dropped instead.
  it("drops what was owed in a repository the panel has since left", async () => {
    receive({
      command: "runRefAction",
      repo: DEFAULT_REPO,
      ref: "feature-b",
      action: "delete",
      seq: ++seq
    });
    clickId("dialogAction");
    clickId("fetchBtn");
    dismiss();
    openUsersQuestion();
    receive({ command: "deleteBranch", status: "error: not fully merged", notFullyMerged: true });
    receive({ command: "fetch", status: "fatal: unable to access remote" });

    receive({ command: "setRepo", repo: OTHER_REPO });
    settleRefresh();
    dismiss();
    await flushMicrotasks();

    expect(dialogShown()).toBe(false);

    receive({ command: "setRepo", repo: DEFAULT_REPO });
    settleRefresh();
  });

  it("owes the batch's summary, and gives up its retry offer, behind the user's question", async () => {
    receive({
      command: "runRefBatchAction",
      repo: DEFAULT_REPO,
      action: "delete",
      targets: ["feature-a", "feature-b"],
      skipped: [],
      seq: ++seq
    });
    clickId("dialogAction");
    dismiss(); // the progress dialog: the delete goes on regardless
    const question = openUsersQuestion();

    // A retry offer is a question with a run behind it, and the run cannot
    // wait on a question that is not on screen (`BatchRun.start` would read
    // it as over). So the offer is given up — the run abandoned — and what
    // round 1 did is owed like any abandoned run's summary.
    receive({
      command: "deleteBranches",
      results: [
        { ref: "feature-a", status: null, notFullyMerged: false },
        { ref: "feature-b", status: "error: not fully merged", notFullyMerged: true }
      ]
    });

    expect(dialogText()).toBe(question);
    expect(document.getElementById("batchRetryOffer")).toBeNull();
    dismiss();
    await flushMicrotasks();
    expect(dialogText()).toContain("1 succeeded, 1 failed");
    expect(dialogText()).toContain("feature-b: error: not fully merged");
    dismiss();
    settleRefresh();
  });
});
