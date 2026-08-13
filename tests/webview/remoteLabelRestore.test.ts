import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// Regression test: switching away from the GING tab and back restores the
// webview from its saved state. The saved commits used to be rendered before
// the remote names were known, so a remote branch at the same commit as its
// local branch was drawn as a second, separate label instead of being folded
// into the local label ("main ⟨origin⟩" became "main" + "origin/main").

const REPO = DEFAULT_REPO;

const defaultViewState = makeViewState({ lastActiveRepo: REPO });

// "main" and "origin/main" point at the same commit (a fully pushed branch).
const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Initial commit",
    refs: [
      { hash: "abc123", name: "main", type: "head" },
      { hash: "abc123", name: "origin/main", type: "remote" }
    ]
  }
];

function savedState(extra: Partial<WebViewState>): WebViewState {
  return {
    gitRepos: { [REPO]: { columnWidths: null } },
    gitBranches: ["main", "remotes/origin/main"],
    gitBranchHead: "main",
    commits,
    commitHead: "abc123",
    avatars: {},
    currentBranches: [],
    currentRepo: REPO,
    moreCommitsAvailable: false,
    maxCommits: 300,
    showRemoteBranches: true,
    expandedCommit: null,
    columnVisibility: { date: true, author: true, commit: true },
    alwaysAcceptCheckoutCommit: false,
    ...extra
  };
}

function combinedBadge() {
  return document.querySelector(".gitRef.head .gitRefCombined");
}
function standaloneRemoteLabel() {
  return document.querySelector(".gitRef.remote:not(.gitRefCombined)");
}

describe("restoring the webview from saved state (tab switch)", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock(savedState({ remotes: ["origin"], pushDefault: null }));
    setupHtml(defaultViewState);
    await import("@/webview/main");
    // No responses delivered: assert on the initial render from saved state.
  });

  it("keeps the remote branch folded into the local branch label", () => {
    const badge = combinedBadge();
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("origin");
    expect(standaloneRemoteLabel()).toBeNull();
  });
});

describe("restoring from a saved state without remotes (pre-upgrade state)", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock(savedState({}));
    setupHtml(defaultViewState);
    await import("@/webview/main");
  });

  it("re-folds the labels once the remotes load", () => {
    // Without the remote names, "origin/main" can't be matched to "main", so
    // the initial render shows two separate labels.
    expect(combinedBadge()).toBeNull();
    expect(standaloneRemoteLabel()).not.toBeNull();

    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });

    // The unchanged commit list short-circuits loadCommits, so loadRemotes
    // itself must trigger the re-render that folds the labels back together.
    expect(combinedBadge()).not.toBeNull();
    expect(standaloneRemoteLabel()).toBeNull();
  });
});
