import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";
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

// A confirmation dialog asks about one repository, and `currentRepo` can move
// underneath it: the host posts `setRepo` whenever the native Source Control
// view's focused repo changes, and that closes no dialogs. Every deferred
// callback that read `this.currentRepo` at answer time therefore aimed the
// user's "Yes" at whichever repo happened to be current by then.
//
// ADR-0019: the premise has to be bound where the user's consent was given —
// before the wait — because the guard and the state change may not have a wait
// between them. The shape here is to *capture* the repo rather than refuse: the
// user consented to acting on repo A, the dialog's own wording described A, and
// the switch was not their doing. Refusing would leave "pressed Yes, nothing
// happened", which is the half-state the same ADR rules out.
//
// The three scenarios below are the irreversible ones — discarded work, deleted
// files, an overwritten working file. They hand the repo on in a chain
// (A -> B -> C -> A) so each assertion names a *different* repo, and a fix that
// simply hard-coded the boot repo would fail the second one.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const REPO_B = "/workspace/repo-b";
const REPO_C = "/workspace/repo-c";

const viewState = makeViewState({
  repos: {
    [DEFAULT_REPO]: { columnWidths: null },
    [REPO_B]: { columnWidths: null },
    [REPO_C]: { columnWidths: null }
  }
});

// commits[0].hash === "*" is what puts the Uncommitted Changes row in the
// table, and that row is where Reset/Clean are raised from.
const commits: GitCommitNode[] = [
  {
    hash: "*",
    parentHashes: ["aaa111"],
    author: "*",
    email: "",
    date: 1700000100,
    message: "Uncommitted Changes (3)",
    refs: []
  },
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

const details: GitCommitDetails = {
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

/** A branch the cleanup scan found merged — the facts that open its row ticked. */
const MERGED: GG.CleanupCandidateFacts = { merged: true, redundant: false, inactive: false };

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main", "feature"],
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
  moreCommitsAvailable: false,
  hard: true
};

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

function dialogIsOpen() {
  return document.getElementById("dialogAction") !== null;
}

function clickYes() {
  document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
}

describe("the repository a confirmation dialog was answered for", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  const sentOf = (command: string) => mock.sentMessages.filter((m) => m.command === command);

  /** The host following the Source Control view onto another repo. It arrives
   *  unannounced, mid-dialog, and dismisses nothing. */
  function hostSwitchesRepoTo(repo: string) {
    receive({ command: "setRepo", repo });
    expect(dialogIsOpen(), "setRepo closed the open dialog").toBe(true);
  }

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
  });

  // `setRepo` starts a reload; answer it so the next scenario opens its menu on
  // a settled view rather than on one with a request still in flight.
  afterEach(() => {
    receive(branchesResponse);
    receive(commitsResponse);
    mock.clearMessages();
  });

  it("discards the uncommitted work of the repo the dialog named, not the one now focused", () => {
    openMenuOn("tr.unsavedChanges");
    clickItem(L.resetUncommitted + E);
    expect(dialogIsOpen()).toBe(true);

    hostSwitchesRepoTo(REPO_B);
    mock.clearMessages();
    clickYes();

    expect(sentOf("resetUncommittedChanges")).toEqual([
      { command: "resetUncommittedChanges", repo: DEFAULT_REPO }
    ]);
  });

  it("deletes the untracked files of the repo the dialog named", () => {
    openMenuOn("tr.unsavedChanges");
    clickItem(L.cleanUntracked + E);
    expect(dialogIsOpen()).toBe(true);

    hostSwitchesRepoTo(REPO_C);
    mock.clearMessages();
    clickYes();

    expect(sentOf("cleanUntrackedFiles")).toEqual([
      { command: "cleanUntrackedFiles", repo: REPO_B }
    ]);
  });

  it("overwrites the working file of the repo the dialog named", () => {
    // This one is raised from the Commit Details View's file list, a different
    // menu on a different element — the same premise, bound the same way.
    document
      .querySelector<HTMLElement>('tr.commit[data-hash="aaa111"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    receive({ command: "commitDetails", commitDetails: details });

    openMenuOn("#commitDetails .gitFile");
    clickItem(L.resetFileToRevision + E);
    expect(dialogIsOpen()).toBe(true);

    hostSwitchesRepoTo(DEFAULT_REPO);
    mock.clearMessages();
    clickYes();

    expect(sentOf("resetFileToRevision")).toEqual([
      { command: "resetFileToRevision", repo: REPO_C, commitHash: "aaa111", filePath: "src/a.ts" }
    ]);
  });

  // The cleanup dialog is the one place that already knew about this — it
  // carried the repo its candidates were scanned for and compared it against
  // `currentRepo`. But it *refused* on a mismatch, silently, and that refusal
  // was the only guard of its kind in the file. It now sends to the repo it
  // carries, like everything above; this test is what says which of the two
  // behaviours is the intended one.
  it("deletes the branches of the repo the cleanup dialog scanned, rather than refusing", () => {
    receive({
      command: "showBranchCleanup",
      repo: DEFAULT_REPO,
      seq: 1,
      payload: {
        candidates: [{ ref: "merged", isRemote: false, facts: MERGED }],
        defaultBranch: "main",
        defaultBranchDate: 1_700_000_000,
        remotesHidden: false,
        scannable: 1
      }
    });
    // A merged candidate opens ticked, so the run has something to delete.
    expect(
      document.querySelector<HTMLInputElement>('#dialog .cleanupRow input[data-ref="merged"]')!
        .checked
    ).toBe(true);

    hostSwitchesRepoTo(REPO_B);
    mock.clearMessages();
    clickYes();

    expect(sentOf("deleteBranches")).toEqual([
      {
        command: "deleteBranches",
        repo: DEFAULT_REPO,
        refs: ["merged"],
        forceDelete: false,
        deleteOnRemotes: false
      }
    ]);

    // Summarise the run, so it goes back to idle. At most one batch runs at a
    // time and a second is refused as busy on purpose, so a scenario that walks
    // away mid-run would silently disarm the next one.
    receive({
      command: "deleteBranches",
      results: [{ ref: "merged", status: null, notFullyMerged: false }]
    });
  });
  // The force-delete retry is the longest wait of the lot: the question is not
  // even asked until git has refused once, so `currentRepo` has had a whole
  // host round-trip to move before the dialog opens, and the whole dialog after
  // that. Capturing at the dialog would already be too late, so the repo rides
  // on the pending record from the delete that was refused. `-D` on a branch
  // git has just called not-fully-merged is about as unrecoverable as this
  // change gets.
  it("force-deletes in the repo the refused delete went to", () => {
    openMenuOn('.gitRef.head[data-name="feature"]');
    clickItem(L.deleteBranch + E);
    expect(dialogIsOpen()).toBe(true);
    clickYes(); // the ordinary, non-force delete
    expect(sentOf("deleteBranch")).toEqual([
      {
        command: "deleteBranch",
        repo: REPO_B,
        branchName: "feature",
        forceDelete: false,
        deleteOnRemotes: false
      }
    ]);

    // The host switches repos while git is still working on the delete, so the
    // refusal — and the question it raises — arrive after the move.
    receive({ command: "setRepo", repo: REPO_C });
    receive({ command: "deleteBranch", status: "not fully merged", notFullyMerged: true });
    expect(dialogIsOpen(), "the force-delete question was never asked").toBe(true);

    mock.clearMessages();
    clickYes();

    expect(sentOf("deleteBranch")).toEqual([
      {
        command: "deleteBranch",
        repo: REPO_B,
        branchName: "feature",
        forceDelete: true,
        deleteOnRemotes: false
      }
    ]);
  });

  // A batch run outlives more waits than any single action: the confirmation,
  // the host round-trip, and — for delete — a retry confirmation on top. So the
  // repo is carried by the run rather than read when each round is sent. The
  // cleanup scenario above covers the delete adapter; this covers the send path
  // of the one batch action that is also one of the confirmation sites.
  it("fast-forwards the branches of the repo the batch was confirmed for", () => {
    receive({
      command: "runRefBatchAction",
      repo: REPO_C,
      action: "fastForward",
      targets: ["feature"],
      skipped: [],
      seq: 2
    });
    expect(dialogIsOpen()).toBe(true);

    hostSwitchesRepoTo(DEFAULT_REPO);
    mock.clearMessages();
    clickYes();

    expect(sentOf("fastForwardBranches")).toEqual([
      { command: "fastForwardBranches", repo: REPO_C, branchNames: ["feature"] }
    ]);
  });
});
