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
  // Off, so a remote branch renders as its own chip rather than folding into
  // the matching local head — the two paths are asserted separately below.
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
  muteMergeCommits: false,
  onLoadScrollToHead: false,
  referenceInputSpaceSubstitution: "None",
  repos: { [REPO]: { columnWidths: null } },
  scmMultiRepoSelection: true,
  showCurrentBranchByDefault: false,
  uncommittedChangesAtHead: false,
  showSpecificBranches: [],
  showRemoteBranches: true,
  showTags: true
};

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["ccc333"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Checked out here",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    hash: "bbb222",
    parentHashes: ["ccc333"],
    author: "Bob",
    email: "bob@example.com",
    date: 1699500000,
    message: "Merged work",
    refs: [
      { hash: "bbb222", name: "done", type: "head" },
      { hash: "bbb222", name: "origin/done", type: "remote" },
      { hash: "bbb222", name: "v1.0", type: "tag" }
    ]
  },
  {
    hash: "ccc333",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1699000000,
    message: "Unmerged work",
    refs: [{ hash: "ccc333", name: "wip", type: "head" }]
  }
];

const chip = (name: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.gitRef[data-name="${name}"]`)!;

describe("merged ref chips in the graph", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main", "done", "wip", "remotes/origin/done"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: [],
      // As the host sends them: `remotes/`-prefixed, and already exempt-filtered
      // — `main` is the checked-out branch, so the host leaves it out.
      dimmedBranches: ["done", "remotes/origin/done"]
    });
    receive({
      command: "loadRemotes",
      remotes: ["origin"],
      pushDefault: null
    });
    receive({
      command: "loadCommits",
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("dims a merged local branch chip", () => {
    expect(chip("done").classList.contains("dimmedRef")).toBe(true);
  });

  it("dims a merged remote branch chip, matching on the normalised name", () => {
    // The host says `remotes/origin/done`; the chip's data-name is
    // `origin/done`. Without the prefix strip this silently never matches.
    expect(chip("origin/done").classList.contains("dimmedRef")).toBe(true);
  });

  it("never dims the checked-out branch, even when it is merged", () => {
    expect(chip("main").classList.contains("dimmedRef")).toBe(false);
    expect(chip("main").classList.contains("active")).toBe(true);
  });

  it("leaves unmerged branches and non-branch refs alone", () => {
    expect(chip("wip").classList.contains("dimmedRef")).toBe(false);
    expect(chip("v1.0").classList.contains("dimmedRef")).toBe(false);
  });

  it("dims nothing when the host sends no dimmed set", () => {
    receive({
      command: "loadBranches",
      branches: ["main", "done", "wip", "remotes/origin/done"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
    expect(document.querySelectorAll(".gitRef.dimmedRef")).toHaveLength(0);
  });
});
