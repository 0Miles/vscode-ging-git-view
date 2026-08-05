import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, setupHtml } from "./setup";

// Regression test: following the Source Control view's repo switch while the
// GING panel was hidden, the extension persists the new repo as
// lastActiveRepo and the revealed webview reboots — but the boot restored
// currentRepo from the saved state (the old repo), and loadRepos only consults
// lastActiveRepo when no current repo survived, so the graph came back showing
// the previous repository. lastActiveRepo must win when it names a different,
// known repo; ordinary reloads (where the two match) must keep restoring the
// saved commits without a reload.

const REPO_A = "/workspace/repo-a";
const REPO_B = "/workspace/repo-b";

function buildViewState(lastActiveRepo: string): GG.GitGraphViewState {
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
    repos: { [REPO_A]: { columnWidths: null }, [REPO_B]: { columnWidths: null } },
    scmMultiRepoSelection: true,
    showCurrentBranchByDefault: false,
    uncommittedChangesAtHead: false,
    showSpecificBranches: [],
    showRemoteBranches: true,
    showTags: true
  };
}

const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Old repo commit",
    refs: [{ hash: "abc123", name: "main", type: "head" }]
  }
];

const savedState: WebViewState = {
  gitRepos: { [REPO_A]: { columnWidths: null }, [REPO_B]: { columnWidths: null } },
  gitBranches: ["main"],
  gitBranchHead: "main",
  remotes: [],
  pushDefault: null,
  commits,
  commitHead: "abc123",
  avatars: {},
  currentBranches: [],
  currentRepo: REPO_A,
  moreCommitsAvailable: false,
  maxCommits: 300,
  showRemoteBranches: true,
  expandedCommit: null,
  columnVisibility: { date: true, author: true, commit: true },
  alwaysAcceptCheckoutCommit: false
};

describe("rebooting after the extension retargeted the view to another repo", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock(savedState);
    setupHtml(buildViewState(REPO_B));
    await import("@/webview/main");
  });

  it("boots on lastActiveRepo, not the repo in the saved state", () => {
    const selects = mock.sentMessages.filter((m) => m.command === "selectRepo");
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((m) => m.repo === REPO_B)).toBe(true);
  });

  it("does not render the old repo's saved commits", () => {
    expect(document.getElementById("commitTable")!.textContent).not.toContain("Old repo commit");
  });
});

describe("rebooting normally (saved state matches lastActiveRepo)", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock(savedState);
    setupHtml(buildViewState(REPO_A));
    await import("@/webview/main");
  });

  it("stays on the saved repo", () => {
    const selects = mock.sentMessages.filter((m) => m.command === "selectRepo");
    expect(selects.every((m) => m.repo === REPO_A)).toBe(true);
  });

  it("restores the saved commits immediately", () => {
    expect(document.getElementById("commitTable")!.textContent).toContain("Old repo commit");
  });
});

// The real vscode.getState() yields undefined (not null) when nothing was ever
// saved — a fresh boot must survive that, not die before requesting any data
// (which left the view stuck on the loading screen forever).
describe("booting fresh with no saved state (getState() is undefined)", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(buildViewState(REPO_B));
    await import("@/webview/main");
  });

  it("boots on lastActiveRepo and requests its data", () => {
    const selects = mock.sentMessages.filter((m) => m.command === "selectRepo");
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((m) => m.repo === REPO_B)).toBe(true);
  });
});
