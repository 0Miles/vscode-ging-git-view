import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, setupHtml } from "./setup";

// The toolbar's repo dropdown (#16): with several repos known, the title block
// becomes a dropdown trigger — chevron, pointer cursor, and a menu of every
// repo from which the user switches the graph. With one repo it stays a plain
// label.

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

const repoTitle = () => document.getElementById("repoTitle")!;
const titleText = () => document.getElementById("repoTitleName")!.textContent;
const menu = () => document.getElementById("contextMenu")!;
const menuItems = () => Array.from(menu().querySelectorAll<HTMLElement>(".contextMenuItem"));

function clickRepoTitle() {
  repoTitle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("toolbar repo dropdown with multiple repos", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(
      buildViewState({ [REPO_A]: { columnWidths: null }, [REPO_B]: { columnWidths: null } }, REPO_A)
    );
    await import("@/webview/main");
  });

  it("dresses the title block as a dropdown trigger", () => {
    expect(repoTitle().classList.contains("multipleRepos")).toBe(true);
    expect(document.getElementById("repoTitleChevron")!.querySelector("svg")).not.toBeNull();
  });

  it("opens a menu of every repo on click, with the current one checked", () => {
    clickRepoTitle();
    expect(menu().classList.contains("active")).toBe(true);

    const labels = menuItems().map((li) => (li.textContent ?? "").trim());
    expect(labels).toEqual(["repo-a", "repo-b"]);

    const [current, other] = menuItems();
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(other.getAttribute("aria-checked")).toBe("false");
  });

  it("switches the graph and tells the host when another repo is chosen", () => {
    mock.clearMessages();
    const other = menuItems().find((li) => (li.textContent ?? "").trim() === "repo-b")!;
    other.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu().classList.contains("active")).toBe(false);
    expect(titleText()).toBe("repo-b");
    expect(mock.sentMessages).toContainEqual(
      expect.objectContaining({ command: "selectRepo", repo: REPO_B })
    );
  });

  it("treats picking the current repo as a no-op", () => {
    clickRepoTitle();
    mock.clearMessages();
    const current = menuItems().find((li) => (li.textContent ?? "").trim() === "repo-b")!;
    current.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu().classList.contains("active")).toBe(false);
    expect(titleText()).toBe("repo-b");
    expect(mock.sentMessages).not.toContainEqual(
      expect.objectContaining({ command: "selectRepo" })
    );
  });
});

describe("toolbar repo dropdown with custom repo names", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(
      buildViewState(
        {
          [REPO_A]: { columnWidths: null, customName: "<b>Main & Co</b>" },
          [REPO_B]: { columnWidths: null }
        },
        REPO_A
      )
    );
    await import("@/webview/main");
  });

  it("shows the custom name in the menu, HTML-escaped as text", () => {
    clickRepoTitle();
    const labels = menuItems().map((li) => (li.textContent ?? "").trim());
    expect(labels).toEqual(["<b>Main & Co</b>", "repo-b"]);
    // The markup must arrive as text, never as elements.
    expect(menuItems()[0].querySelector("b")).toBeNull();
  });
});

describe("toolbar repo title with a single repo", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(buildViewState({ [REPO_A]: { columnWidths: null } }, REPO_A));
    await import("@/webview/main");
  });

  it("stays a plain label: no dropdown affordances, and a click opens nothing", () => {
    expect(repoTitle().classList.contains("multipleRepos")).toBe(false);
    clickRepoTitle();
    expect(menu().classList.contains("active")).toBe(false);
  });
});
