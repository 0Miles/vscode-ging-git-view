import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, setupHtml } from "./setup";

// The toolbar's repo dropdown (#16): with several repos known, the title block
// becomes a select-style dropdown — clicking it opens a listbox of every repo
// from which the user switches the graph, with full keyboard support. With one
// repo it stays a plain label.

const REPO_A = "/workspace/repo-a";
const REPO_B = "/workspace/repo-b";
const REPO_C = "/workspace/repo-c";

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

const trigger = () => document.getElementById("repoTitle")!;
const titleText = () => document.getElementById("repoTitleName")!.textContent;
const list = () => document.getElementById("repoDropdownList")!;
const items = () => Array.from(list().querySelectorAll<HTMLElement>(".repoDropdownItem"));
const isOpen = () => list().classList.contains("active");

function clickTrigger() {
  trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function keydown(key: string) {
  list().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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

  it("dresses the title block as a select-style trigger", () => {
    expect(trigger().classList.contains("multipleRepos")).toBe(true);
    expect(document.getElementById("repoTitleChevron")!.querySelector("svg")).not.toBeNull();
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().tabIndex).toBe(0);
    expect(trigger().title).not.toBe("");
  });

  it("opens a listbox of every repo on click, current one selected", () => {
    clickTrigger();
    expect(isOpen()).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    const labels = items().map((li) => (li.textContent ?? "").trim());
    expect(labels).toEqual(["repo-a", "repo-b"]);

    const [current, other] = items();
    expect(current.classList.contains("current")).toBe(true);
    expect(current.getAttribute("aria-selected")).toBe("true");
    expect(other.classList.contains("current")).toBe(false);
    expect(other.getAttribute("aria-selected")).toBe("false");
    // Full paths surface as tooltips, so same-named folders stay tellable apart.
    expect(items().map((li) => li.title)).toEqual([REPO_A, REPO_B]);

    // Toggle: a second click on the trigger closes it again.
    clickTrigger();
    expect(isOpen()).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens from the keyboard: Enter on the focused trigger", () => {
    trigger().focus();
    trigger().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(isOpen()).toBe(true);
    keydown("Escape");
    expect(isOpen()).toBe(false);
  });

  it("closes on a click outside the dropdown", () => {
    clickTrigger();
    expect(isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(false);
  });

  it("switches the graph and tells the host when another repo is chosen", () => {
    clickTrigger();
    mock.clearMessages();
    items()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(isOpen()).toBe(false);
    expect(titleText()).toBe("repo-b");
    expect(mock.sentMessages).toContainEqual(
      expect.objectContaining({ command: "selectRepo", repo: REPO_B })
    );
  });

  it("treats picking the current repo as a no-op", () => {
    clickTrigger();
    mock.clearMessages();
    items()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); // repo-b is current

    expect(isOpen()).toBe(false);
    expect(titleText()).toBe("repo-b");
    expect(mock.sentMessages).not.toContainEqual(
      expect.objectContaining({ command: "selectRepo" })
    );
  });

  it("navigates with the keyboard: arrows and Home/End move, Enter selects", () => {
    clickTrigger();
    keydown("ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    keydown("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    // No wrap-around: the ends are hard stops, like a native select.
    keydown("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    keydown("Home");
    expect(document.activeElement).toBe(items()[0]);
    keydown("End");
    expect(document.activeElement).toBe(items()[1]);
    keydown("ArrowUp");
    expect(document.activeElement).toBe(items()[0]);

    mock.clearMessages();
    keydown("Enter");
    expect(isOpen()).toBe(false);
    expect(titleText()).toBe("repo-a");
    expect(mock.sentMessages).toContainEqual(
      expect.objectContaining({ command: "selectRepo", repo: REPO_A })
    );
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    clickTrigger();
    keydown("Escape");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("dismisses on Tab instead of letting focus walk out of the popup", () => {
    clickTrigger();
    keydown("Tab");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
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
          [REPO_C]: { columnWidths: null }
        },
        REPO_A
      )
    );
    await import("@/webview/main");
  });

  it("shows the custom name in the list, HTML-escaped as text", () => {
    clickTrigger();
    const labels = items().map((li) => (li.textContent ?? "").trim());
    expect(labels).toEqual(["<b>Main & Co</b>", "repo-c"]);
    // The markup must arrive as text, never as elements.
    expect(items()[0].querySelector("b")).toBeNull();
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
    expect(trigger().classList.contains("multipleRepos")).toBe(false);
    expect(trigger().hasAttribute("aria-haspopup")).toBe(false);
    expect(trigger().hasAttribute("tabindex")).toBe(false);
    expect(trigger().title).toBe("");
    clickTrigger();
    expect(isOpen()).toBe(false);
  });
});
