import { describe, expect, it } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { buildFindMatches, planFindLoad, resolveFindCurrent } from "@/webview/find";

const commit = (hash: string, message: string, refs: GitCommitNode["refs"] = []) => ({
  hash,
  message,
  refs,
  author: "T",
  email: "t@example.com",
  date: 1,
  parentHashes: [],
  signatureStatus: ""
});

describe("buildFindMatches", () => {
  it("merges commit and branch hits by hash in graph order", () => {
    const matches = buildFindMatches(
      "main",
      [
        commit("a", "first", [
          { hash: "a", name: "main", type: "head" },
          { hash: "a", name: "origin/main", type: "remote" }
        ]),
        commit("b", "main cleanup")
      ],
      [
        { ref: "main", name: "main", hash: "a", depth: 0 },
        { ref: "remotes/origin/main", name: "origin/main", hash: "a", depth: 0 },
        {
          ref: "feature/main-legacy",
          name: "feature/main-legacy",
          hash: "z",
          depth: 5
        }
      ]
    );

    expect(matches).toEqual([
      {
        hash: "a",
        loaded: true,
        depth: 0,
        loadDepth: 0,
        branches: [
          { ref: "main", name: "main" },
          { ref: "remotes/origin/main", name: "origin/main" }
        ]
      },
      { hash: "b", loaded: true, depth: 1, loadDepth: 1, branches: [] },
      {
        hash: "z",
        loaded: false,
        depth: 5,
        loadDepth: 5,
        branches: [{ ref: "feature/main-legacy", name: "feature/main-legacy" }]
      }
    ]);
  });

  it("keeps loaded stash rows ahead of a branch beyond the commit window", () => {
    const matches = buildFindMatches(
      "work",
      [
        commit("stash-1", "work stash", [{ hash: "stash-1", name: "stash@{0}", type: "stash" }]),
        commit("stash-2", "other stash", [{ hash: "stash-2", name: "stash@{1}", type: "stash" }]),
        commit("a", "first"),
        commit("b", "work commit")
      ],
      [{ ref: "work-later", name: "work-later", hash: "z", depth: 2 }]
    );

    expect(matches.map((match) => match.hash)).toEqual(["stash-1", "b", "z"]);
    expect(planFindLoad(2, matches[2])).toEqual({
      maxCommits: 3,
      additionalCommits: 1,
      confirm: false
    });
  });
});

describe("resolveFindCurrent", () => {
  it("keeps the target hash when refreshed results insert earlier matches", () => {
    const matches = [
      { hash: "new", loaded: true, depth: 0, loadDepth: 0, branches: [] },
      {
        hash: "target",
        loaded: true,
        depth: 1,
        loadDepth: 1,
        branches: [{ ref: "feature/target", name: "feature/target" }]
      }
    ];

    expect(resolveFindCurrent(matches, "target", 0, 1)).toBe(1);
  });

  it("falls forward by graph position when the target disappears", () => {
    const matches = [
      { hash: "inserted-before", loaded: true, depth: 50, loadDepth: 50, branches: [] },
      { hash: "next", loaded: true, depth: 200, loadDepth: 200, branches: [] }
    ];

    expect(resolveFindCurrent(matches, "vanished", 0, 1, 100)).toBe(1);
  });
});

describe("planFindLoad", () => {
  it("requires confirmation only when more than 200 additional commits are needed", () => {
    expect(planFindLoad(300, { loaded: false, loadDepth: 499 })?.confirm).toBe(false);
    expect(planFindLoad(300, { loaded: false, loadDepth: 500 })?.confirm).toBe(true);
  });

  it("reloads the current window when a moved branch head is not in its stale snapshot", () => {
    expect(planFindLoad(300, { loaded: false, loadDepth: 100 })).toEqual({
      maxCommits: 300,
      additionalCommits: 0,
      confirm: false
    });
  });
});
