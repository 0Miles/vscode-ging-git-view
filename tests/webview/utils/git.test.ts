import { describe, expect, it } from "vitest";

import {
  commitMatchesQuery,
  commitNodeTooltip,
  commitsReachableFrom,
  dropCommitPossible,
  graphNavigationTarget,
  isNotFullyMergedBranchError,
  latestTagName,
  signatureCategory,
  substituteRefSpaces
} from "@/webview/utils/git";

const tooltipLabels = { head: "On HEAD", branches: "Branches: {0}", tags: "Tags: {0}" };

const commit = {
  message: "Add login feature",
  author: "Alice",
  email: "alice@example.com",
  hash: "abcdef1234567890",
  refs: [{ name: "feature/login" }]
};

describe("commitMatchesQuery", () => {
  it("matches the message case-insensitively", () => {
    expect(commitMatchesQuery(commit, "LOGIN")).toBe(true);
  });
  it("matches the author name", () => {
    expect(commitMatchesQuery(commit, "alice")).toBe(true);
  });
  it("matches the author email", () => {
    expect(commitMatchesQuery(commit, "example.com")).toBe(true);
  });
  it("matches a hash prefix", () => {
    expect(commitMatchesQuery(commit, "abcdef")).toBe(true);
  });
  it("matches a ref name", () => {
    expect(commitMatchesQuery(commit, "feature/")).toBe(true);
  });
  it("returns false when nothing matches", () => {
    expect(commitMatchesQuery(commit, "zzz")).toBe(false);
  });
  it("returns false for an empty query", () => {
    expect(commitMatchesQuery(commit, "")).toBe(false);
  });
});

describe("commitNodeTooltip", () => {
  it("lists branches and tags on the commit", () => {
    const refs = [
      { name: "main", type: "head" },
      { name: "origin/main", type: "remote" },
      { name: "v1.0", type: "tag" }
    ];
    expect(commitNodeTooltip(refs, false, tooltipLabels)).toBe(
      "Branches: main, origin/main\nTags: v1.0"
    );
  });

  it("includes the HEAD line when the commit is checked out", () => {
    expect(commitNodeTooltip([{ name: "main", type: "head" }], true, tooltipLabels)).toBe(
      "On HEAD\nBranches: main"
    );
  });

  it("returns an empty string for a commit with no refs and not HEAD", () => {
    expect(commitNodeTooltip([], false, tooltipLabels)).toBe("");
  });

  it("shows only the HEAD line for a detached HEAD with no refs", () => {
    expect(commitNodeTooltip([], true, tooltipLabels)).toBe("On HEAD");
  });
});

describe("latestTagName", () => {
  it("returns the first tag in graph order (newest first)", () => {
    const commits = [
      { refs: [{ name: "main", type: "head" }] },
      { refs: [{ name: "v2.0", type: "tag" }] },
      { refs: [{ name: "v1.0", type: "tag" }] }
    ];
    expect(latestTagName(commits)).toBe("v2.0");
  });

  it("returns null when no commit is tagged", () => {
    expect(latestTagName([{ refs: [{ name: "main", type: "head" }] }])).toBeNull();
  });

  it("returns null for no commits", () => {
    expect(latestTagName([])).toBeNull();
  });
});

describe("substituteRefSpaces", () => {
  it("leaves the value unchanged for 'None'", () => {
    expect(substituteRefSpaces("my branch name", "None")).toBe("my branch name");
  });

  it("replaces spaces with hyphens for 'Hyphen'", () => {
    expect(substituteRefSpaces("my branch name", "Hyphen")).toBe("my-branch-name");
  });

  it("replaces spaces with underscores for 'Underscore'", () => {
    expect(substituteRefSpaces("my branch name", "Underscore")).toBe("my_branch_name");
  });
});

describe("commitsReachableFrom", () => {
  // a -> b -> c (c is root); d -> b (side branch sharing b)
  const parents: { [h: string]: string[] } = { a: ["b"], b: ["c"], c: [], d: ["b"] };
  const parentsOf = (h: string) => parents[h];

  it("includes the start and all ancestors", () => {
    expect([...commitsReachableFrom(["a"], parentsOf)].toSorted()).toEqual(["a", "b", "c"]);
  });

  it("merges ancestry from multiple starts", () => {
    expect([...commitsReachableFrom(["a", "d"], parentsOf)].toSorted()).toEqual([
      "a",
      "b",
      "c",
      "d"
    ]);
  });

  it("does not include unrelated commits", () => {
    expect(commitsReachableFrom(["c"], parentsOf).has("a")).toBe(false);
  });

  it("tolerates unknown commits (undefined parents)", () => {
    expect([...commitsReachableFrom(["x"], parentsOf)]).toEqual(["x"]);
  });

  it("terminates on cycles", () => {
    const cyclicParents: { [h: string]: string[] } = { p: ["q"], q: ["p"] };
    expect([...commitsReachableFrom(["p"], (h) => cyclicParents[h])].toSorted()).toEqual([
      "p",
      "q"
    ]);
  });
});

describe("signatureCategory", () => {
  it("maps good signatures", () => {
    expect(signatureCategory("G")).toBe("good");
  });
  it("maps unverifiable signatures", () => {
    expect(signatureCategory("U")).toBe("unverified");
    expect(signatureCategory("E")).toBe("unverified");
  });
  it("maps bad/expired/revoked signatures", () => {
    for (const s of ["B", "X", "Y", "R"]) expect(signatureCategory(s)).toBe("bad");
  });
  it("returns null for no signature or unset", () => {
    expect(signatureCategory("N")).toBeNull();
    expect(signatureCategory("")).toBeNull();
    expect(signatureCategory(undefined)).toBeNull();
  });
});

// Build commits + lookup from a {hash: [parents]} map.
function buildCommitGraph(graph: { [hash: string]: string[] }) {
  const commits = Object.entries(graph).map(([hash, parentHashes]) => ({ hash, parentHashes }));
  const lookup: { [hash: string]: number } = {};
  commits.forEach((c, i) => (lookup[c.hash] = i));
  return { commits, lookup };
}

describe("dropCommitPossible", () => {
  const build = buildCommitGraph;

  it("allows dropping a commit on a linear chain reaching HEAD", () => {
    // HEAD=h3 → h2 → h1 → h0(root)
    const { commits, lookup } = build({ h3: ["h2"], h2: ["h1"], h1: ["h0"], h0: [] });
    expect(dropCommitPossible("h1", commits, lookup, "h3")).toBe(true);
    expect(dropCommitPossible("h3", commits, lookup, "h3")).toBe(true); // HEAD itself
  });

  it("refuses a root commit (no parent)", () => {
    const { commits, lookup } = build({ h1: ["h0"], h0: [] });
    expect(dropCommitPossible("h0", commits, lookup, "h1")).toBe(false);
  });

  it("refuses a merge commit", () => {
    // HEAD=m is a merge of a and b
    const { commits, lookup } = build({ m: ["a", "b"], a: ["base"], b: ["base"], base: [] });
    expect(dropCommitPossible("m", commits, lookup, "m")).toBe(false);
  });

  it("refuses a commit whose descendant chain passes through a merge", () => {
    const { commits, lookup } = build({ m: ["a", "b"], a: ["base"], b: ["base"], base: [] });
    expect(dropCommitPossible("a", commits, lookup, "m")).toBe(false); // child m is a merge
  });

  it("refuses a commit that forks into multiple children", () => {
    // x is a branch point: both y and z have x as parent
    const { commits, lookup } = build({ y: ["x"], z: ["x"], x: ["w"], w: [] });
    expect(dropCommitPossible("x", commits, lookup, "y")).toBe(false);
  });

  it("refuses a commit whose chain does not reach HEAD", () => {
    const { commits, lookup } = build({ a: ["b"], b: ["c"], c: [] });
    expect(dropCommitPossible("b", commits, lookup, "unrelated")).toBe(false);
  });
});

describe("graphNavigationTarget", () => {
  // A merge m with two parents p1 (first) and p2 (alternative); m has two
  // children c1 (first) and c2 (alternative) in this commits-array order.
  const commits = [
    { hash: "c1", parentHashes: ["m"] },
    { hash: "c2", parentHashes: ["m"] },
    { hash: "m", parentHashes: ["p1", "p2"] },
    { hash: "p1", parentHashes: [] },
    { hash: "p2", parentHashes: [] }
  ];
  const m = commits[2];

  it("follows the first parent by default", () => {
    expect(graphNavigationTarget(m, commits, "parent", false)).toBe("p1");
  });

  it("follows the alternative (second) parent of a merge", () => {
    expect(graphNavigationTarget(m, commits, "parent", true)).toBe("p2");
  });

  it("follows the first child by default", () => {
    expect(graphNavigationTarget(m, commits, "child", false)).toBe("c1");
  });

  it("follows the alternative (second) child at a fork", () => {
    expect(graphNavigationTarget(m, commits, "child", true)).toBe("c2");
  });

  it("returns undefined when there is no alternative branch", () => {
    const linear = [
      { hash: "b", parentHashes: ["a"] },
      { hash: "a", parentHashes: [] }
    ];
    expect(graphNavigationTarget(linear[1], linear, "parent", true)).toBeUndefined(); // root, no parent
    expect(graphNavigationTarget(linear[1], linear, "child", true)).toBeUndefined(); // only one child
  });
});

describe("isNotFullyMergedBranchError", () => {
  it("detects git's not-fully-merged error via the locale-stable command hint", () => {
    const err =
      "error: the branch 'feature' is not fully merged\n" +
      "hint: If you are sure you want to delete it, run 'git branch -D feature'\n";
    expect(isNotFullyMergedBranchError(err)).toBe(true);
    // The command hint stays in English even when the rest is translated.
    const translated =
      "錯誤: 分支「feature」沒有完全合併\n提示： 請執行「git branch -D feature」\n";
    expect(isNotFullyMergedBranchError(translated)).toBe(true);
  });

  it("returns false for other errors and for null", () => {
    expect(isNotFullyMergedBranchError("error: some unrelated failure")).toBe(false);
    expect(isNotFullyMergedBranchError(null)).toBe(false);
  });
});
