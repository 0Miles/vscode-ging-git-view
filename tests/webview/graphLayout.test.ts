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

// Widening the loaded commit window can redraw rows that were already on
// screen. That is deliberate behaviour, not a bug waiting to be fixed: while a
// parent sits off-graph, every merge onto it collapses to the same id -1
// sentinel vertex, so determinePath() takes the "branch is normal" path —
// allocates a new colour, draws a line to the bottom edge, and eats one lane on
// every row below. Once the next page makes that parent a real vertex that is
// already on a branch, the same merge takes the merge path instead: it joins
// the existing point and finishes early, so the lane and the colour it used to
// consume are freed. The second page knows more, so it draws the truer picture.
//
// See ADR-0020 (docs/adr/0020-commit-loading-stays-whole-window.md). "Rows
// above stay put" is a property this codebase does not have today, and that is
// why append-style loading was rejected rather than built — these tests exist
// to make the absence visible, not to lock in a defect.
//
// The numbers below are the ADR's minimal repro, cross-checked against a second
// independent implementation. The tests assert those measurements and nothing
// more. In particular they do NOT assert "the fork flips, therefore something
// visibly changes": across 12,000 synthetic repositories the fork flipped 389
// times with no visual difference at all, so a test phrased that way would be
// flaky.
describe("graph layout across a widened commit window", () => {
  // The palette package.json declares for `graph.palette` — which is the one
  // users actually get. VS Code answers every registered key with the manifest
  // default, so the six-colour fallback in src/config.ts is unreachable, and
  // tests/extension/config.test.ts pins this exact list to say so (#71, #77).
  // The three-colour makeConfig() shared with the suite above is a palette
  // production never hands out.
  //
  // For this fixture the two agree bit for bit: its raw lane colours only reach
  // 2, so getVertexColour()'s `colour % palette.length` folds nothing either
  // way. The numbers below are pinned against what a user sees rather than
  // against a value that exists only in this file.
  const shippedPalette = [
    "#0085d9",
    "#d9008f",
    "#00d90a",
    "#d98500",
    "#a300d9",
    "#ff0000",
    "#00d9cc",
    "#e138e8",
    "#85d900",
    "#dc5b23",
    "#6f24d6",
    "#ffcc00"
  ];

  /** Lay out one whole window and read back what the row positions became. */
  function layOut(commits: GitCommitNode[]): { widths: number[]; colours: number[] } {
    document.body.innerHTML = '<div id="commitGraph"></div>';
    const g = new Graph("commitGraph", { ...makeConfig(), graphColours: shippedPalette });
    g.loadCommits(commits, commits[0].hash, lookupOf(commits));
    return {
      widths: g.getWidthsAtVertices(),
      colours: commits.map((_, i) => g.getVertexColour(i))
    };
  }

  it("moves Z's lane and colour once the next page turns its off-graph parent into a vertex", () => {
    // M merges A and P; A and Z both have P as their only parent. P is the row
    // the second page adds, so on the first page all three references to it are
    // the same id -1 sentinel.
    const firstPage = [
      commit("M", ["A", "P"]), // 0: merge
      commit("A", ["P"]), // 1
      commit("Z", ["P"]) // 2: the row that moves
    ];
    const secondPage = [...firstPage, commit("P", [])]; // 3: P arrives

    const Z = 2;
    const firstPass = layOut(firstPage);
    const secondPass = layOut(secondPage);

    expect(firstPass.widths[Z]).toBe(62);
    expect(firstPass.colours[Z]).toBe(2);
    expect(secondPass.widths[Z]).toBe(46);
    expect(secondPass.colours[Z]).toBe(1);
  });

  it("leaves a linear history untouched when the window widens", () => {
    // No merge anywhere, so nothing reaches the fork in determinePath() at all
    // and R arriving on the second page changes none of the rows above it.
    const firstPage = [commit("C", ["B"]), commit("B", ["A"]), commit("A", ["R"])];
    const secondPage = [...firstPage, commit("R", [])]; // R arrives

    const firstPass = layOut(firstPage);
    const secondPass = layOut(secondPage);

    expect(firstPass.widths).toEqual([30, 30, 30]);
    expect(firstPass.colours).toEqual([0, 0, 0]);
    expect(secondPass.widths).toEqual([30, 30, 30, 30]);
    expect(secondPass.colours).toEqual([0, 0, 0, 0]);
  });
});
