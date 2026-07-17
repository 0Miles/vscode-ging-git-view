import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, receive, setupHtml } from "./setup";

const REPO = "/workspace/my-repo";

const viewState: GG.GitGraphViewState = {
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
  fileTreeCompactFolders: false,
  // Global default layout is the tree; the toggle stores a per-repo override.
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
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Initial commit",
    refs: [{ hash: "abc123", name: "main", type: "head" }]
  }
];

describe("Commit Details View file tree/list toggle", () => {
  let sentMessages: GG.RequestMessage[];

  beforeAll(async () => {
    vi.resetModules();
    const mock = createVscodeMock();
    sentMessages = mock.sentMessages;
    setupHtml(viewState);
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

    document
      .querySelector<HTMLElement>('tr.commit[data-hash="abc123"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    receive({
      command: "commitDetails",
      commitDetails: {
        hash: "abc123",
        parents: [],
        author: "Alice",
        email: "alice@example.com",
        committer: "Alice",
        committerEmail: "alice@example.com",
        authorDate: 1700000000,
        commitDate: 1700000000,
        body: "Initial commit",
        fileChanges: [
          {
            oldFilePath: "src/a.ts",
            newFilePath: "src/a.ts",
            type: "M",
            additions: 1,
            deletions: 1
          },
          {
            oldFilePath: "README.md",
            newFilePath: "README.md",
            type: "A",
            additions: 5,
            deletions: 0
          }
        ]
      }
    });
  });

  it("renders the file tree with both toggle buttons, tree active", () => {
    expect(document.querySelector("#commitDetailsFiles .gitFolder")).not.toBeNull();
    const buttons = document.querySelectorAll<HTMLElement>(".cdvFileViewBtn");
    expect(buttons.length).toBe(2);
    expect(
      document
        .querySelector<HTMLElement>('.cdvFileViewBtn[data-viewtype="File Tree"]')!
        .classList.contains("active")
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLElement>('.cdvFileViewBtn[data-viewtype="File List"]')!
        .classList.contains("active")
    ).toBe(false);
  });

  it("switches to the flat list, persists the choice, and re-wires file rows", () => {
    document
      .querySelector<HTMLElement>('.cdvFileViewBtn[data-viewtype="File List"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // The files section is now the flat list (full paths, no folder rows).
    expect(document.querySelector("#commitDetailsFiles .gitFolder")).toBeNull();
    const list = document.querySelector("#commitDetailsFiles .gitFileList");
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain("src/a.ts");

    // The active state moved to the list button.
    expect(
      document
        .querySelector<HTMLElement>('.cdvFileViewBtn[data-viewtype="File List"]')!
        .classList.contains("active")
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLElement>('.cdvFileViewBtn[data-viewtype="File Tree"]')!
        .classList.contains("active")
    ).toBe(false);

    // The per-repo choice was sent to the extension host for persistence.
    const saved = sentMessages.filter((m) => m.command === "saveRepoState");
    expect(saved.length).toBe(1);
    expect((saved[0] as { state: GG.GitRepoState }).state.fileViewType).toBe("File List");

    // The re-rendered rows are wired up: clicking a modified file requests its diff.
    document
      .querySelector<HTMLElement>("#commitDetailsFiles .gitFile.M")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const diffs = sentMessages.filter((m) => m.command === "viewDiff");
    expect(diffs.length).toBe(1);
    expect((diffs[0] as { newFilePath: string }).newFilePath).toBe("src/a.ts");
  });

  it("switches back to the tree view", () => {
    document
      .querySelector<HTMLElement>('.cdvFileViewBtn[data-viewtype="File Tree"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(document.querySelector("#commitDetailsFiles .gitFolder")).not.toBeNull();
    expect(document.querySelector("#commitDetailsFiles .gitFileList")).toBeNull();
    const saved = sentMessages.filter((m) => m.command === "saveRepoState");
    expect((saved[saved.length - 1] as { state: GG.GitRepoState }).state.fileViewType).toBe(
      "File Tree"
    );
  });
});
