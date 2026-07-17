import { describe, expect, it } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { Graph } from "@/webview/graph";

// The graph layout assumes a commit's parents always appear *below* it (a higher
// index in the list). When that invariant is violated — e.g. a stash placed by
// date above its base commit — the layout walk used to never mark such a parent
// processed, so findStart() returned the same vertex forever and the webview
// froze (the user had to close and reopen the tab). These tests feed adversarial
// orderings and assert the walk terminates; if a guard regresses, the synchronous
// loadCommits() call hangs and the test times out rather than passing silently.

function makeConfig(): Config {
  return {
    graphColours: ["#0085d9", "#d9008c", "#00a86b"],
    graphStyle: "rounded",
    grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
    uncommittedChangesAtHead: false
  } as unknown as Config;
}

function makeGraph(): Graph {
  document.body.innerHTML = '<div id="commitGraph"></div>';
  return new Graph("commitGraph", makeConfig());
}

function lookupOf(commits: GitCommitNode[]): { [hash: string]: number } {
  const lookup: { [hash: string]: number } = {};
  commits.forEach((c, i) => (lookup[c.hash] = i));
  return lookup;
}

function commit(hash: string, parentHashes: string[]): GitCommitNode {
  return { hash, parentHashes, author: "T", email: "t@t.com", date: 1, message: hash, refs: [] };
}

function circleCount(): number {
  // Count vertex nodes only — the HEAD node draws an extra decorative
  // .currentHalo ring that is not a vertex.
  return document.querySelectorAll("#commitGraph circle:not(.currentHalo)").length;
}

describe("graph layout termination", () => {
  it("does not hang when a (stash) node sits above its base commit", () => {
    // S's only parent A is listed *above* it — the exact shape a stash gets when
    // a date-based insertion drops it below its base. Pre-fix this looped forever.
    const commits = [
      commit("A", ["I"]), // 0: base of the stash
      commit("S", ["A"]), // 1: stash, parent A is above it
      commit("I", []) // 2
    ];
    const g = makeGraph();
    g.loadCommits(commits, "A", lookupOf(commits));
    g.render(null);
    expect(circleCount()).toBeGreaterThan(0);
  });

  it("does not hang on a merge commit whose parent is listed above it", () => {
    const commits = [
      commit("X", ["M"]), // 0: child of the merge
      commit("P", ["root"]), // 1: a parent of M, listed above M
      commit("M", ["P", "Q"]), // 2: merge; first parent P is above it
      commit("Q", ["root"]), // 3
      commit("root", []) // 4
    ];
    const g = makeGraph();
    g.loadCommits(commits, "X", lookupOf(commits));
    g.render(null);
    expect(circleCount()).toBeGreaterThan(0);
  });

  it("does not hang when every parent is listed above its child (fully reversed)", () => {
    const commits = [
      commit("A", ["B"]), // 0
      commit("B", ["C"]), // 1
      commit("C", []) // 2 (A→B→C all point upward)
    ];
    const g = makeGraph();
    g.loadCommits(commits, "A", lookupOf(commits));
    g.render(null);
    expect(circleCount()).toBeGreaterThan(0);
  });

  it("still lays out a normal in-order graph correctly (guard is inert on valid input)", () => {
    const commits = [commit("C", ["B"]), commit("B", ["A"]), commit("A", [])];
    const g = makeGraph();
    g.loadCommits(commits, "C", lookupOf(commits));
    g.render(null);
    // Every vertex ends up on a branch, so each draws a node.
    expect(circleCount()).toBe(3);
  });

  it("lays out a valid merge without spurious extra work", () => {
    const commits = [
      commit("M", ["A", "B"]), // 0: merge of A and B
      commit("A", ["base"]), // 1
      commit("B", ["base"]), // 2
      commit("base", []) // 3
    ];
    const g = makeGraph();
    g.loadCommits(commits, "M", lookupOf(commits));
    g.render(null);
    expect(circleCount()).toBe(4);
  });
});
