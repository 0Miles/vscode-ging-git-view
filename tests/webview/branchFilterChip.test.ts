import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, receive, setupHtml } from "./setup";

// The toolbar's branch-filter chip: the graph's only outward sign that it is
// showing a subset of the branches, plus the one control that clears it. The
// label text itself is `branchFilterLabel`'s job and is covered in
// utils/git.test.ts; what's asserted here is that the chip is wired to every
// path that can change the filter.

const REPO_A = "/workspace/repo-a";
const REPO_B = "/workspace/repo-b";
const BRANCHES = ["main", "wip", "remotes/origin/done"];

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
  lastActiveRepo: REPO_A,
  loadMoreAutomatically: false,
  loadMoreCommits: 75,
  markdown: false,
  muteCommitsNotAncestorsOfHead: false,
  muteMergeCommits: false,
  onLoadScrollToHead: false,
  referenceInputSpaceSubstitution: "None",
  repos: { [REPO_A]: { columnWidths: null }, [REPO_B]: { columnWidths: null } },
  scmMultiRepoSelection: true,
  showCurrentBranchByDefault: false,
  uncommittedChangesAtHead: false,
  showSpecificBranches: [],
  showRemoteBranches: true,
  showTags: true
};

const chip = () => document.getElementById("branchFilterChip")!;
const chipText = () => document.getElementById("branchFilterText")!.textContent;
const chipShown = () => chip().classList.contains("active");

/** Deliver a branch filter the way the host does on a (re)load. */
function loadWithFilter(filter: string[]) {
  receive({
    command: "loadBranches",
    branches: BRANCHES,
    head: "main",
    hard: true,
    isRepo: true,
    filter
  });
}

describe("the graph's branch-filter chip", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
  });

  it("stays hidden while the filter is empty — show all is the unmarked state", () => {
    loadWithFilter([]);
    expect(chipShown()).toBe(false);
    expect(chipText()).toBe("");
  });

  it("appears with the filter's label and full list once a filter loads", () => {
    loadWithFilter(BRANCHES);
    expect(chipShown()).toBe(true);
    expect(chipText()).toBe("main +2");
    expect(chip().title).toContain("origin/done");
  });

  it("disappears when the host pushes an empty filter", () => {
    loadWithFilter(BRANCHES);
    receive({ command: "setBranchFilter", branches: [] });
    expect(chipShown()).toBe(false);
    expect(chipText()).toBe("");
  });

  it("drops the previous repo's filter on a repo switch, before the new one loads", () => {
    loadWithFilter(BRANCHES);
    expect(chipShown()).toBe(true);
    receive({ command: "setRepo", repo: REPO_B });
    expect(chipShown()).toBe(false);
  });

  it("asks the host to clear the filter, rather than clearing it optimistically", () => {
    loadWithFilter(["main"]);
    mock.clearMessages();
    document.getElementById("branchFilterClear")!.dispatchEvent(new MouseEvent("click"));
    expect(mock.sentMessages).toContainEqual({ command: "clearBranchFilter" });
    // The host owns the filter: the chip is still up until it answers.
    expect(chipShown()).toBe(true);
  });
});
