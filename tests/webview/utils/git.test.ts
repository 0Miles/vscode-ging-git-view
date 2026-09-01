import { describe, expect, it } from "vitest";

import {
  branchFilterLabel,
  commitMatchesQuery,
  commitNodeTooltip,
  commitsReachableFrom,
  dropCommitPossible,
  graphNavigationTarget,
  latestTagName,
  rebaseOntoRange,
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

// buildCommitGraph, with local branch refs from `heads` attached — graph order
// is the object's key order, newest first.
function buildRefGraph(
  graph: { [hash: string]: string[] },
  heads: { [hash: string]: string[] } = {}
) {
  const commits = Object.entries(graph).map(([hash, parentHashes]) => ({
    hash,
    parentHashes,
    refs: (heads[hash] ?? []).map((name) => ({ name, type: "head" }))
  }));
  const lookup: { [hash: string]: number } = {};
  commits.forEach((c, i) => (lookup[c.hash] = i));
  return { commits, lookup };
}

describe("rebaseOntoRange", () => {
  const build = buildRefGraph;

  // HEAD=c → b → a → root, with branch "feature" on c.
  const linear = build({ c: ["b"], b: ["a"], a: ["root"], root: [] }, { c: ["feature"] });

  it("reads the same range whichever commit was clicked first", () => {
    const forwards = rebaseOntoRange("a", "c", linear.commits, linear.lookup);
    const backwards = rebaseOntoRange("c", "a", linear.commits, linear.lookup);
    expect(forwards).toEqual(backwards);
    expect(forwards!.from).toBe("a");
    expect(forwards!.tip).toBe("c");
  });

  it("bounds the range below the older selection, so both ends are replayed", () => {
    // git excludes `<upstream>`, so naming "a" there would leave behind one of
    // the two commits the user compared. Its parent is the bound instead.
    expect(rebaseOntoRange("a", "c", linear.commits, linear.lookup)!.upstream).toBe("root");
  });

  it("declines a range whose older end is a root commit", () => {
    // Nothing to name as the lower bound, and `--onto` cannot spell a range
    // without one. The caller falls back to the plain rebase.
    expect(rebaseOntoRange("root", "b", linear.commits, linear.lookup)).toBeNull();
  });

  it("takes the first parent of a merge as the bound", () => {
    // The first parent is the line the range was read along.
    const { commits, lookup } = build({
      m: ["main1", "side1"],
      main1: ["base"],
      side1: ["base"],
      base: []
    });
    expect(rebaseOntoRange("m", "main1", commits, lookup)).toMatchObject({ upstream: "base" });
  });

  it("reports the local branches sitting on the tip", () => {
    expect(rebaseOntoRange("a", "c", linear.commits, linear.lookup)!.tipBranches).toEqual([
      "feature"
    ]);
    // Nothing points at b, so a range ending there can only be spelled as a hash.
    expect(rebaseOntoRange("a", "b", linear.commits, linear.lookup)!.tipBranches).toEqual([]);
  });

  it("ignores tags and remote branches when naming the tip", () => {
    const commits = [
      { hash: "b", parentHashes: ["a"], refs: [{ name: "v1", type: "tag" }] },
      { hash: "a", parentHashes: ["root"], refs: [] }
    ];
    expect(rebaseOntoRange("a", "b", commits, { b: 0, a: 1 })!.tipBranches).toEqual([]);
  });

  it("falls back to graph order for two commits on divergent branches", () => {
    // x and y both sit on base; neither reaches the other. y is listed lower
    // (older in graph order), so it becomes the upstream.
    const { commits, lookup } = build({ x: ["base"], y: ["base"], base: [] });
    expect(rebaseOntoRange("x", "y", commits, lookup)).toMatchObject({
      upstream: "base",
      from: "y",
      tip: "x"
    });
  });

  it("falls back to graph order when the ancestry runs past the loaded commits", () => {
    // b's parent was never loaded, so walking parents from b never reaches a.
    const { commits, lookup } = build({ b: ["unloaded"], a: ["alsoUnloaded"] });
    // The bound is the older selection's parent even when that parent was never
    // loaded: its hash is known from the child, and git resolves it for itself.
    expect(rebaseOntoRange("a", "b", commits, lookup)).toMatchObject({
      upstream: "alsoUnloaded",
      from: "a",
      tip: "b"
    });
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

describe("branchFilterLabel", () => {
  const tooltip = "Showing only:\n{0}";
  const three = ["main", "wip", "remotes/origin/done"];

  it("returns null for an empty filter, which means show all", () => {
    expect(branchFilterLabel([], tooltip)).toBeNull();
  });

  it("shows the branch name when a single branch is filtered", () => {
    expect(branchFilterLabel(["main"], tooltip)).toEqual({
      text: "main",
      tooltip: "Showing only:\nmain"
    });
  });

  it("strips the remotes/ prefix, matching the graph's ref chips", () => {
    expect(branchFilterLabel(["remotes/origin/feature/x"], tooltip)).toEqual({
      text: "origin/feature/x",
      tooltip: "Showing only:\norigin/feature/x"
    });
  });

  it("counts the branches beyond the first, not the whole filter", () => {
    expect(branchFilterLabel(three, tooltip)?.text).toBe("main +2");
  });

  it("lists every filtered branch in the tooltip, one per line", () => {
    expect(branchFilterLabel(three, tooltip)?.tooltip).toBe(
      "Showing only:\nmain\nwip\norigin/done"
    );
  });
});
