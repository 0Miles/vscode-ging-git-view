import { beforeAll, describe, expect, it, vi } from "vitest";

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
      { hash: "base1", name: "feature", type: "head" },
      { hash: "base1", name: "origin/feature", type: "remote" }
    ]
  }
];

function dialogText(): string {
  return document.getElementById("dialog")!.textContent ?? "";
}

function dismissDialog() {
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
}

describe("runRefAction delegated from the Branches side-view", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main", "feature"],
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

  it("opens the same merge dialog as the in-graph menu", () => {
    receive({
      command: "runRefAction",
      repo: REPO,
      ref: "feature",
      isRemote: false,
      action: "merge",
      seq: 1
    });

    // The merge form dialog: three option checkboxes plus the remember toggle.
    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(true);
    expect(document.getElementById("dialogInput2")).not.toBeNull();
    expect(document.getElementById("dialogRememberChoice")).not.toBeNull();
    dismissDialog();
  });

  it("ignores a duplicate delivery of the same seq", () => {
    receive({
      command: "runRefAction",
      repo: REPO,
      ref: "feature",
      isRemote: false,
      action: "merge",
      seq: 1
    });
    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(false);
  });

  it("runs remote-branch actions with the remote/branch split applied", () => {
    receive({
      command: "runRefAction",
      repo: REPO,
      ref: "origin/feature",
      isRemote: true,
      action: "deleteRemote",
      seq: 2
    });
    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(true);
    expect(dialogText()).toContain("origin/feature");

    // Confirming sends the action with remote and branch split on the first slash.
    mock.clearMessages();
    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
    expect(mock.sentMessages.find((m) => m.command === "deleteRemoteBranch")).toMatchObject({
      remote: "origin",
      branchName: "feature"
    });
    dismissDialog();
  });

  it("ignores actions that never apply to the checked-out branch", () => {
    receive({
      command: "runRefAction",
      repo: REPO,
      ref: "main",
      isRemote: false,
      action: "delete",
      seq: 3
    });
    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(false);
  });

  it("holds an action for another repo instead of running it here", () => {
    receive({
      command: "runRefAction",
      repo: "/somewhere/else",
      ref: "feature",
      isRemote: false,
      action: "merge",
      seq: 4
    });
    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(false);
  });
});
