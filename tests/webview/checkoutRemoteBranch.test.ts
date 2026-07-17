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
  customBranchGlobPatterns: [],
  contextMenuActionsVisibility: DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
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

// A remote branch whose name contains slashes ("origin/fix/something-1").
const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: [{ hash: "abc123", name: "origin/fix/something-1", type: "remote" }]
  }
];

describe("checking out a remote branch whose name contains slashes", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({
      command: "loadCommits",
      commits,
      head: "abc123",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("defaults the new local branch to the full path, not just the last segment", () => {
    const ref = document.querySelector<HTMLElement>(".gitRef.remote");
    expect(ref).not.toBeNull();
    expect(ref!.dataset.name).toBe("origin/fix/something-1");

    // Double-clicking a ref triggers the checkout-branch action.
    ref!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    // The create-local-branch dialog should default to "fix/something-1"
    // (only the "origin/" remote prefix stripped), not "something-1".
    const input = document.getElementById("dialogInput0") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("fix/something-1");
  });

  it("sends a checkoutBranch message carrying the full branch path", () => {
    mock.clearMessages();
    document
      .getElementById("dialogAction")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const checkout = mock.sentMessages.find((m) => m.command === "checkoutBranch");
    expect(checkout).toMatchObject({
      command: "checkoutBranch",
      branchName: "fix/something-1",
      remoteBranch: "origin/fix/something-1"
    });
  });
});
