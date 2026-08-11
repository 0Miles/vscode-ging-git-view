import { beforeAll, describe, expect, it, vi } from "vitest";

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
  muteCommitsNotAncestorsOfHead: false,
  muteMergeCommits: true,
  onLoadScrollToHead: false,
  referenceInputSpaceSubstitution: "None",
  // Global setting is false, but the repo carries a per-repo override of true.
  repos: { [REPO]: { columnWidths: null, showRemoteBranches: true } },
  scmMultiRepoSelection: true,
  showCurrentBranchByDefault: false,

  uncommittedChangesAtHead: false,
  showSpecificBranches: [],
  showRemoteBranches: false,
  showTags: true
};

describe("showRemoteBranches per-repo override", () => {
  let sentMessages: GG.RequestMessage[];
  beforeAll(async () => {
    vi.resetModules();
    sentMessages = createVscodeMock().sentMessages;
    setupHtml(viewState);
    await import("@/webview/main");
    // Complete the startup handshake: until the initial load lands, the webview
    // holds off any further branch request, and the toggle would look inert for
    // reasons that have nothing to do with what is under test.
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
  });

  // The value no longer travels in the request — the host resolves it. What
  // still has to track the per-repo override is the webview's memo of the value
  // in force: get that wrong and the side-view's toggle either reloads for
  // nothing or, worse, is swallowed as a no-op.
  it("treats the per-repo override as the value in force, not the global setting", () => {
    const before = sentMessages.length;
    receive({ command: "setShowRemoteBranches", value: true });
    // The override already says true, so this announcement changes nothing.
    expect(sentMessages.length).toBe(before);
  });

  it("reloads when told to drop remotes, against that override", () => {
    const before = sentMessages.length;
    receive({ command: "setShowRemoteBranches", value: false });
    expect(sentMessages.slice(before).some((m) => m.command === "loadBranches")).toBe(true);
  });
});
