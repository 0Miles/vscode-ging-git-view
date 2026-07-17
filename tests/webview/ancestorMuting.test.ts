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

  combineLocalAndRemoteBranchLabels: true,
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
  muteCommitsNotAncestorsOfHead: true,
  muteMergeCommits: false,
  onLoadScrollToHead: false,
  referenceInputSpaceSubstitution: "None",
  repos: { [REPO]: { columnWidths: null } },
  showCurrentBranchByDefault: false,

  uncommittedChangesAtHead: false,
  showSpecificBranches: [],
  showRemoteBranches: true,
  showTags: true
};

// HEAD = abc123; side999 is a separate branch tip not reachable from HEAD, so
// it should be muted, while HEAD and its ancestor def456 should not be.
const commits: GitCommitNode[] = [
  {
    hash: "side999",
    parentHashes: ["def456"],
    author: "Carol",
    email: "carol@example.com",
    date: 1700200000,
    message: "Side branch work",
    refs: [{ hash: "side999", name: "feature", type: "head" }]
  },
  {
    hash: "abc123",
    parentHashes: ["def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "On head",
    refs: [{ hash: "abc123", name: "main", type: "head" }]
  },
  {
    hash: "def456",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Initial commit",
    refs: []
  }
];

describe("muteCommitsNotAncestorsOfHead", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
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
    receive({
      command: "loadCommits",
      commits,
      head: "abc123",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("mutes commits that are not ancestors of HEAD", () => {
    expect(
      document.querySelector('.commit[data-hash="side999"]')!.classList.contains("muted")
    ).toBe(true);
  });

  it("does not mute HEAD or its ancestors", () => {
    expect(document.querySelector('.commit[data-hash="abc123"]')!.classList.contains("muted")).toBe(
      false
    );
    expect(document.querySelector('.commit[data-hash="def456"]')!.classList.contains("muted")).toBe(
      false
    );
  });

  it("mutes nothing when HEAD is not within the loaded commits", () => {
    // HEAD points to a commit that isn't loaded: ancestry is unknowable, so no
    // commit should be muted on that basis.
    receive({
      command: "loadCommits",
      commits,
      head: "notloaded000",
      moreCommitsAvailable: false,
      hard: true
    });
    for (const c of commits) {
      expect(
        document.querySelector(`.commit[data-hash="${c.hash}"]`)!.classList.contains("muted")
      ).toBe(false);
    }
  });
});
