import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, setupHtml } from "./setup";

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
  });

  it("requests branches with remotes from the per-repo override, ignoring the global setting", () => {
    const msg = sentMessages.find((m) => m.command === "loadBranches") as
      | Extract<GG.RequestMessage, { command: "loadBranches" }>
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.showRemoteBranches).toBe(true); // per-repo override wins over global false
  });
});
