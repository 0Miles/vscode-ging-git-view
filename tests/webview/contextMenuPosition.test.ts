import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { mergeContextMenuActionsVisibility } from "@/backend/utils/contextMenuVisibility";
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
  contextMenuActionsVisibility: mergeContextMenuActionsVisibility({}),
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

const commits: GitCommitNode[] = [
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
    refs: []
  }
];

const VIEWPORT_HEIGHT = 768;
const VIEWPORT_WIDTH = 1024;

// jsdom performs no layout, so getBoundingClientRect() reports zeros; stub the
// menu's measured size so the positioning maths has a real height/width to work
// with. Dimensions are (re)applied per test.
function stubMenuSize(menu: HTMLElement, width: number, height: number) {
  menu.getBoundingClientRect = () =>
    ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON() {}
    }) as DOMRect;
}

function openMenuAt(pageX: number, pageY: number) {
  const row = document.querySelector<HTMLElement>('tr.commit[data-hash="abc123"]')!;
  const ev = new MouseEvent("contextmenu", { bubbles: true });
  // jsdom doesn't derive pageX/pageY from clientX/clientY, so set them directly.
  Object.defineProperty(ev, "pageX", { value: pageX });
  Object.defineProperty(ev, "pageY", { value: pageY });
  row.dispatchEvent(ev);
}

describe("context menu positioning", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    Object.defineProperty(window, "innerHeight", { value: VIEWPORT_HEIGHT, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: VIEWPORT_WIDTH, configurable: true });
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

  beforeEach(() => {
    const menu = document.getElementById("contextMenu")!;
    menu.className = "";
    menu.style.left = "0px";
    menu.style.top = "0px";
  });

  it("opens down/right of the cursor when there is room", () => {
    const menu = document.getElementById("contextMenu")!;
    stubMenuSize(menu, 200, 150);

    openMenuAt(100, 100);

    expect(parseFloat(menu.style.left)).toBe(98); // pageX - 2
    expect(parseFloat(menu.style.top)).toBe(98); // pageY - 2
  });

  it("flips upward when there is no room below the cursor", () => {
    const menu = document.getElementById("contextMenu")!;
    stubMenuSize(menu, 200, 150);

    // Click near the bottom: 700 + 150 > 768, so the menu must open upward.
    openMenuAt(100, 700);

    // Bottom-anchored to the cursor: pageY - height + 2.
    expect(parseFloat(menu.style.top)).toBe(700 - 150 + 2);
  });

  it("never spills past the top edge when the space above is also too small", () => {
    const menu = document.getElementById("contextMenu")!;
    // Menu taller than the cursor's distance from the top: flipping up would put
    // its top at 700 - 750 + 2 = -48, clipping the leading items (the reported bug).
    stubMenuSize(menu, 200, 750);

    openMenuAt(100, 700);

    const top = parseFloat(menu.style.top);
    // Clamped inside the viewport and pinned to the top (menu taller than space).
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBe(2);
  });

  it("never spills past the left edge when the space to the left is also too small", () => {
    const menu = document.getElementById("contextMenu")!;
    // No room to the right (200 + 900 > 1024) forces a flip left, but the menu is
    // wider than the cursor's distance from the left edge, so flipping would put
    // its left at 200 - 900 + 2 = -698.
    stubMenuSize(menu, 900, 150);

    openMenuAt(200, 100);

    const left = parseFloat(menu.style.left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBe(2);
  });
});
