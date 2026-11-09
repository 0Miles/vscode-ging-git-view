import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode, GitFileChange } from "@/backend/types";
import { generateGitFileTree, serializeGitFileTree } from "@/webview/utils/fileTree";

import { DEFAULT_REPO, createVscodeMock, makeViewState, setupHtml } from "./setup";

// Regression test: the webview state is persisted with vscode.setState, which
// JSON-serializes it. The Commit Details View file tree used Map for folder
// children, which JSON turns into {}. Restoring the webview (tab switch back,
// e.g. after opening another extension's tab over it) then threw
// "folder.children.values is not a function" inside renderTable, which also
// aborted renderGraph — the graph vanished and every refresh kept throwing.

const REPO = DEFAULT_REPO;

const defaultViewState = makeViewState({
  autoCenterCommitDetailsView: false,
  lastActiveRepo: REPO
});

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

const fileChanges: GitFileChange[] = [
  { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 },
  {
    oldFilePath: "src/sub/b.ts",
    newFilePath: "src/sub/b.ts",
    type: "M",
    additions: 2,
    deletions: 1
  }
];

const commitDetails: GitCommitDetails = {
  hash: "abc123",
  parents: [],
  author: "Alice",
  email: "alice@example.com",
  committer: "Alice",
  committerEmail: "alice@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  body: "Initial commit",
  fileChanges
};

function savedState(expandedCommit: unknown): WebViewState {
  return {
    gitRepos: { [REPO]: { columnWidths: null } },
    gitBranches: ["main"],
    gitBranchHead: "main",
    remotes: [],
    pushDefault: null,
    commits,
    commitHead: "abc123",
    avatars: {},
    currentBranches: [],
    currentRepo: REPO,
    moreCommitsAvailable: false,
    maxCommits: 300,
    showRemoteBranches: true,
    expandedCommit: expandedCommit as WebViewState["expandedCommit"],
    columnVisibility: { date: true, author: true, commit: true },
    alwaysAcceptCheckoutCommit: false
  };
}

const expandedCommitBase = {
  id: 0,
  hash: "abc123",
  srcElem: null,
  commitDetails,
  compareWithHash: null,
  compareWithSrcElem: null,
  compareFromHash: null,
  compareToHash: null,
  compareFileChanges: null
};

describe("restoring an expanded Commit Details View from saved state", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    // State as saved by the current code: the file tree in its serialized,
    // JSON-safe form (the mock round-trips it through JSON like VS Code does).
    mock = createVscodeMock(
      savedState({
        ...expandedCommitBase,
        fileTree: serializeGitFileTree(generateGitFileTree(fileChanges))
      })
    );
    setupHtml(defaultViewState);
    await import("@/webview/main");
  });

  it("renders the graph", () => {
    expect(document.querySelectorAll("#commitGraph svg *").length).toBeGreaterThan(0);
  });

  it("restores the Commit Details View, including the file tree, without re-requesting it", () => {
    expect(document.getElementById("commitDetailsFiles")).not.toBeNull();
    const folders = Array.from(document.querySelectorAll(".gitFolderName")).map(
      (e) => e.textContent
    );
    expect(folders).toContain("src");
    expect(document.querySelectorAll("#commitDetailsFiles .gitFile").length).toBe(2);
    expect(mock.sentMessages.some((m) => m.command === "commitDetails")).toBe(false);
  });
});

describe("restoring from a legacy saved state (file tree Maps lost to JSON)", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    // States saved before the serialized form: children was a Map, which
    // vscode.setState's JSON serialization collapsed to {}.
    mock = createVscodeMock(
      savedState({
        ...expandedCommitBase,
        fileTree: generateGitFileTree(fileChanges)
      })
    );
    setupHtml(defaultViewState);
    await import("@/webview/main");
  });

  it("still renders the graph instead of crashing", () => {
    expect(document.querySelectorAll("#commitGraph svg *").length).toBeGreaterThan(0);
  });

  it("drops the corrupt file tree and re-requests the commit details", () => {
    expect(mock.sentMessages.some((m) => m.command === "commitDetails")).toBe(true);
  });
});
