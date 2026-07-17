import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, setupHtml } from "./setup";

const REPO = "/workspace/my-repo";

function makeViewState(keybindings: GG.KeybindingConfig): GG.GitGraphViewState {
  return {
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
    keybindings,
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
}

function pressCtrl(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
}

describe("keyboard shortcuts", () => {
  describe("with the default Find binding (CTRL/CMD + F)", () => {
    beforeAll(async () => {
      vi.resetModules();
      createVscodeMock();
      setupHtml(makeViewState({ find: "f", refresh: "r", scrollToHead: "h", scrollToStash: "s" }));
      await import("@/webview/main");
    });

    it("opens the Find Widget on Ctrl+F", () => {
      const findWidget = document.getElementById("findWidget")!;
      expect(findWidget.classList.contains("active")).toBe(false);
      pressCtrl("f");
      expect(findWidget.classList.contains("active")).toBe(true);
    });
  });

  describe("with the Find binding set to UNASSIGNED", () => {
    beforeAll(async () => {
      vi.resetModules();
      createVscodeMock();
      setupHtml(makeViewState({ find: null, refresh: "r", scrollToHead: "h", scrollToStash: "s" }));
      await import("@/webview/main");
    });

    it("does not open the Find Widget on Ctrl+F", () => {
      const findWidget = document.getElementById("findWidget")!;
      pressCtrl("f");
      expect(findWidget.classList.contains("active")).toBe(false); // shortcut disabled
    });
  });
});
