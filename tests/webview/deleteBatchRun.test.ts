import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, receive, setupHtml } from "./setup";

const REPO = "/workspace/my-repo";

const viewState: GG.GitGraphViewState = {
  autoCenterCommitDetailsView: true,
  commitDetailsViewLocation: "Inline",
  referenceLabelAlignment: "Normal",
  combineLocalAndRemoteBranchLabels: false,
  dialogDeleteBranchForceDelete: false,
  dialogCherryPickNoCommit: false,
  dialogAddTagType: "annotated",
  dialogCreateBranchCheckOut: false,
  dialogMergeNoFastForward: true,
  dialogMergeSquash: false,
  dialogResetMode: "mixed",
  dialogMemory: {},
  contextMenuActionsVisibility: DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
  customBranchGlobPatterns: [],
  customEmojiShortcodeMappings: {},
  dateFormat: "Date & Time",
  dateCustomFormat: "DD MMM YYYY",
  defaultColumnVisibility: { date: true, author: true, commit: true },
  enhancedAccessibility: false,
  fetchAvatars: false,
  fileTreeCompactFolders: true,
  fileViewType: "File Tree",
  graphColours: ["#0085d9"],
  graphStyle: "rounded",
  initialLoadCommits: 300,
  issueLinkingRegex: "",
  issueLinkingUrl: "",
  keybindings: { find: "f", refresh: "r", scrollToHead: "h", scrollToStash: "s" },
  lastActiveRepo: null,
  loadMoreAutomatically: false,
  loadMoreCommits: 75,
  markdown: false,
  muteCommitsNotAncestorsOfHead: false,
  muteMergeCommits: true,
  onLoadScrollToHead: false,
  referenceInputSpaceSubstitution: "None",
  repos: { [REPO]: { columnWidths: null } },
  showCurrentBranchByDefault: false,
  uncommittedChangesAtHead: false,
  showSpecificBranches: [],
  showRemoteBranches: true,
  showTags: true
};

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

function dialogActive(): boolean {
  return document.getElementById("dialog")!.classList.contains("active");
}

function confirmDialog() {
  document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
}

function dismissDialog() {
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
}

/** Answer the reload a summarised batch kicks off, so the view settles before
 *  the next test delegates its batch. */
function settleRefresh() {
  receive({
    command: "loadBranches",
    branches: ["main", "feature-a", "feature-b"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
  receive({
    command: "loadCommits",
    commits,
    head: "head1",
    moreCommitsAvailable: false,
    hard: true
  });
}

let seq = 0;
function receiveBatchDelete(targets: string[], skipped: GG.BatchSkipped[] = []) {
  receive({
    command: "runRefBatchAction",
    repo: REPO,
    action: "delete",
    targets,
    skipped,
    seq: ++seq
  });
}

describe("batch delete delegated from the Branches side-view", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main", "feature-a", "feature-b"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({
      command: "loadCommits",
      commits,
      head: "head1",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  beforeEach(() => {
    mock.clearMessages();
  });

  it("confirms the whole set — including who was skipped — then sends round 1", () => {
    receiveBatchDelete(["feature-a", "feature-b"], [{ ref: "main", reason: "checkedOut" }]);

    expect(dialogActive()).toBe(true);
    expect(dialogText()).toContain("delete these 2 branches");
    expect(dialogText()).toContain("feature-a");
    expect(dialogText()).toContain("Skipped, currently checked out: main");

    confirmDialog();
    expect(mock.sentMessages.find((m) => m.command === "deleteBranches")).toMatchObject({
      refs: ["feature-a", "feature-b"],
      forceDelete: false,
      deleteOnRemotes: false
    });
  });

  it("offers the not-fully-merged refusals as one force round and folds the summary", () => {
    receive({
      command: "deleteBranches",
      results: [
        { ref: "feature-a", status: null, notFullyMerged: false },
        { ref: "feature-b", status: "error: not fully merged", notFullyMerged: true }
      ]
    });

    // One force round for the one refusal a force delete can fix.
    expect(dialogActive()).toBe(true);
    expect(dialogText()).toContain("1 of these branches are not fully merged");
    expect(dialogText()).toContain("feature-b");
    expect(dialogText()).not.toContain("feature-a");

    confirmDialog();
    expect(mock.sentMessages.find((m) => m.command === "deleteBranches")).toMatchObject({
      refs: ["feature-b"],
      forceDelete: true,
      deleteOnRemotes: false
    });

    // The force round succeeded: every ref is accounted for, so the batch ends
    // with a refresh rather than an error dialog.
    mock.clearMessages();
    receive({
      command: "deleteBranches",
      results: [{ ref: "feature-b", status: null, notFullyMerged: false }]
    });
    expect(mock.sentMessages.some((m) => m.command === "loadBranches")).toBe(true);
    expect(dialogText()).not.toContain("failed");
    settleRefresh();
  });

  it("still reports round 1 when the force round is declined", () => {
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

    dismissDialog();
    // Declining the force round still ends a batch that did real work: the
    // summary covers round 1 rather than closing in silence.
    expect(dialogActive()).toBe(true);
    expect(dialogText()).toContain("1 succeeded, 1 failed");
    expect(dialogText()).toContain("feature-b");
    dismissDialog(); // dismissing the summary refreshes the graph
    settleRefresh();
  });

  it("refuses a second batch while one is in flight, without disturbing it", () => {
    receiveBatchDelete(["feature-a"]);
    confirmDialog(); // round 1 in flight

    receiveBatchDelete(["feature-b"]);
    confirmDialog(); // second batch confirmed while the first awaits results
    expect(dialogText()).toContain("Another batch action is still in progress");
    expect(mock.sentMessages.filter((m) => m.command === "deleteBranches")).toHaveLength(1);

    // The refused batch must not have disturbed the run in flight: its
    // response still folds into a summary.
    dismissDialog();
    mock.clearMessages();
    receive({
      command: "deleteBranches",
      results: [{ ref: "feature-a", status: null, notFullyMerged: false }]
    });
    expect(mock.sentMessages.some((m) => m.command === "loadBranches")).toBe(true);
    settleRefresh();
  });
});
