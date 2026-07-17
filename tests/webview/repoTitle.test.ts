import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, receive, setupHtml } from "./setup";

// The toolbar's left-hand title block: the repo's display name (custom name,
// else folder name) over the checked-out branch, kept in sync across branch
// loads and repo switches.

const REPO_A = "/workspace/repo-a";
const REPO_B = "/workspace/repo-b";

function buildViewState(repos: GG.GitRepoSet, lastActiveRepo: string): GG.GitGraphViewState {
  return {
    autoCenterCommitDetailsView: false,
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
    lastActiveRepo,
    loadMoreAutomatically: false,
    loadMoreCommits: 75,
    markdown: false,
    muteCommitsNotAncestorsOfHead: false,
    muteMergeCommits: false,
    onLoadScrollToHead: false,
    referenceInputSpaceSubstitution: "None",
    repos,
    showCurrentBranchByDefault: false,
    uncommittedChangesAtHead: false,
    showSpecificBranches: [],
    showRemoteBranches: true,
    showTags: true
  };
}

const titleText = () => document.getElementById("repoTitleName")!.textContent;
const branchText = () => document.getElementById("repoTitleBranch")!.textContent;

describe("toolbar repo title", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(
      buildViewState({ [REPO_A]: { columnWidths: null }, [REPO_B]: { columnWidths: null } }, REPO_A)
    );
    await import("@/webview/main");
  });

  it("shows the repo's folder name on boot, with the branch still unknown", () => {
    expect(titleText()).toBe("repo-a");
    expect(branchText()).toBe("");
  });

  it("shows the checked-out branch once branches load", () => {
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    expect(titleText()).toBe("repo-a");
    expect(branchText()).toBe("main");
  });

  it("updates the repo name immediately on a repo switch, then the branch on its load", () => {
    receive({ command: "setRepo", repo: REPO_B });
    expect(titleText()).toBe("repo-b");
    receive({
      command: "loadBranches",
      branches: ["develop"],
      head: "develop",
      hard: true,
      isRepo: true,
      filter: []
    });
    expect(branchText()).toBe("develop");
  });
});

describe("toolbar repo title with a custom repo name", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(
      buildViewState({ [REPO_A]: { columnWidths: null, customName: "My Project" } }, REPO_A)
    );
    await import("@/webview/main");
  });

  it("prefers the custom name over the folder name", () => {
    expect(titleText()).toBe("My Project");
  });
});
