import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, receive, setupHtml } from "./setup";

const REPO = "/workspace/my-repo";

const defaultViewState: GG.GitGraphViewState = {
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

const twoCommits: GitCommitNode[] = [
  {
    hash: "merge789",
    parentHashes: ["abc123", "def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700100000,
    message: "Merge feature",
    refs: [{ hash: "merge789", name: "main", type: "head" }]
  },
  {
    hash: "abc123",
    parentHashes: ["def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: []
  },
  {
    hash: "def456",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Initial commit",
    refs: [{ hash: "def456", name: "v1.0", type: "tag" }]
  }
];

describe("webview rendering", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(defaultViewState);
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
      commits: twoCommits,
      head: "merge789",
      moreCommitsAvailable: true,
      hard: true
    });
  });

  it("shows Load More Commits button when more commits are available", () => {
    expect(document.getElementById("loadMoreCommitsBtn")).not.toBeNull();
  });

  it("renders tag labels when showTags is enabled", () => {
    const tagRef = document.querySelector(".gitRef.tag");
    expect(tagRef).not.toBeNull();
    expect(tagRef!.textContent).toContain("v1.0");
  });

  it("highlights matching commits via the Find widget (Ctrl+F)", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const input = document.getElementById("findInput") as HTMLInputElement;
    input.value = "Add feature";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "e" }));

    expect(
      document.querySelector('tr.commit[data-hash="abc123"]')!.classList.contains("findMatch")
    ).toBe(true);
    expect(
      document.querySelector('tr.commit[data-hash="def456"]')!.classList.contains("findMatch")
    ).toBe(false);
    expect(document.getElementById("findCount")!.textContent).toBe("1 of 1");

    // Close it again so later tests start clean.
    document
      .getElementById("findInput")!
      .dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("blinks the HEAD commit when Ctrl+H is pressed", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true }));
    const headRow = document.querySelector('tr.commit[data-hash="merge789"]');
    expect(headRow!.classList.contains("blinking")).toBe(true);
  });

  it("marks the current head branch label as active", () => {
    const activeRef = document.querySelector(".gitRef.head.active");
    expect(activeRef).not.toBeNull();
    expect(activeRef!.textContent).toContain("main");
  });

  it("mutes merge commits (>1 parent) when muteMergeCommits is enabled", () => {
    const mergeRow = document.querySelector('.commit[data-hash="merge789"]');
    expect(mergeRow).not.toBeNull();
    expect(mergeRow!.classList.contains("muted")).toBe(true);

    const normalRow = document.querySelector('.commit[data-hash="abc123"]');
    expect(normalRow!.classList.contains("muted")).toBe(false);
  });
});
