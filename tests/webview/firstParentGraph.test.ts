import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// #205: with `history.firstParentOnly` on, a first-parent chain of merged pull
// requests was drawn as a mesh — every merge kept a line for its second parent,
// which the `--first-parent` walk never loads, so each ran off the bottom edge.
// The commits keep their real parents (the merge prompts count them), so the
// graph learns the mode from the load answer and draws the first parent alone.
//
// The graph's width is the measure: a first-parent chain drawn as one straight
// lane is exactly as wide as a linear history of the same length, and every
// stray second-parent line widens it by a lane.

const REPO = DEFAULT_REPO;

function node(hash: string, parentHashes: string[], refs: GitCommitNode["refs"] = []) {
  return {
    hash,
    parentHashes,
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: hash,
    refs
  } satisfies GitCommitNode;
}

// m2 and m1 merge branches whose commits (x2, x1) a first-parent walk never
// reaches.
const firstParentChain = [
  node("m2", ["m1", "x2"], [{ hash: "m2", name: "main", type: "head" }]),
  node("m1", ["c0", "x1"]),
  node("c0", [])
];
// The same rows with nothing merged: the width one straight lane takes.
const linear = [
  node("m2", ["m1"], [{ hash: "m2", name: "main", type: "head" }]),
  node("m1", ["c0"]),
  node("c0", [])
];

function graphWidth(): string | null {
  return document.querySelector("#commitGraph svg")!.getAttribute("width");
}

function savedState(extra: Partial<WebViewState>): WebViewState {
  return {
    gitRepos: { [REPO]: { columnWidths: null } },
    gitBranches: ["main"],
    gitBranchHead: "main",
    commits: firstParentChain,
    commitHead: "m2",
    avatars: {},
    currentBranches: [],
    currentRepo: REPO,
    moreCommitsAvailable: false,
    maxCommits: 300,
    showRemoteBranches: false,
    expandedCommit: null,
    columnVisibility: { date: true, author: true, commit: true },
    alwaysAcceptCheckoutCommit: false,
    ...extra
  };
}

async function boot(initialState: WebViewState | null = null) {
  vi.resetModules();
  createVscodeMock(initialState);
  setupHtml(makeViewState({ lastActiveRepo: REPO }));
  await import("@/webview/main");
}

function loadBranches() {
  receive({
    command: "loadBranches",
    token: 0,
    branches: ["main"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
}

function loadCommits(
  commits: GitCommitNode[],
  opts: { onlyFollowFirstParent?: boolean; hard?: boolean } = {}
) {
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: "m2",
    moreCommitsAvailable: false,
    hard: opts.hard ?? true,
    ...(opts.onlyFollowFirstParent === undefined
      ? {}
      : { onlyFollowFirstParent: opts.onlyFollowFirstParent })
  });
}

describe("the graph in first-parent mode (#205)", () => {
  let straightLane: string | null;

  beforeEach(async () => {
    await boot();
    loadBranches();
    loadCommits(linear);
    straightLane = graphWidth();
  });

  it("draws a first-parent load as one straight lane", () => {
    loadCommits(firstParentChain, { onlyFollowFirstParent: true });
    expect(graphWidth()).toBe(straightLane);
  });

  it("still draws every parent when the load followed them all", () => {
    loadCommits(firstParentChain, { onlyFollowFirstParent: false });
    expect(graphWidth()).not.toBe(straightLane);
  });

  it("redraws when only the mode changed, even for the same commits on a soft refresh", () => {
    loadCommits(firstParentChain, { onlyFollowFirstParent: false });
    loadCommits(firstParentChain, { onlyFollowFirstParent: true, hard: false });
    expect(graphWidth()).toBe(straightLane);
  });
});

describe("restoring a first-parent graph from saved state (#205)", () => {
  it("redraws the saved commits in the mode they were loaded in", async () => {
    await boot();
    loadBranches();
    loadCommits(linear);
    const straightLane = graphWidth();

    // A tab switch restores the panel from its saved state and draws the saved
    // commits before any new load answers.
    await boot(savedState({ onlyFollowFirstParent: true }));
    expect(graphWidth()).toBe(straightLane);
  });
});
