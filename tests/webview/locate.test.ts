import { describe, expect, it } from "vitest";

import { planLocate } from "@/webview/locate";

describe("planLocate", () => {
  it("reveals a commit that is already drawn, whatever its depth", () => {
    expect(planLocate({ loaded: true, logDepth: 900, maxCommits: 300 })).toEqual({
      kind: "reveal"
    });
    expect(planLocate({ loaded: true, logDepth: null, maxCommits: 300 })).toEqual({
      kind: "reveal"
    });
  });

  it("reports a commit the graph's history leaves out", () => {
    expect(planLocate({ loaded: false, logDepth: null, maxCommits: 300 })).toEqual({
      kind: "notInGraph"
    });
  });

  it("widens the loaded commit window just far enough to draw the commit", () => {
    // Position 899 is the 900th `git log` entry.
    expect(planLocate({ loaded: false, logDepth: 899, maxCommits: 300 })).toEqual({
      kind: "load",
      maxCommits: 900
    });
  });

  it("never shrinks the window, even when the depth says it already reaches", () => {
    // History moved between the answer and now: load what is there once more,
    // rather than setting the window back and dropping drawn commits.
    expect(planLocate({ loaded: false, logDepth: 10, maxCommits: 300 })).toEqual({
      kind: "load",
      maxCommits: 300
    });
  });
});
