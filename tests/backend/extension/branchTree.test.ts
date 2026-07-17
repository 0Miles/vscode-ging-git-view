import { describe, expect, it } from "vitest";

import {
  buildBranchTree,
  buildGroupedBranchRoots,
  type BranchTreeFolder,
  type BranchTreeGroup,
  type BranchTreeLeaf
} from "@/extension/branchTree";

const leaves = (nodes: ReturnType<typeof buildBranchTree>): BranchTreeLeaf[] =>
  nodes.filter((n): n is BranchTreeLeaf => n.type === "leaf");
const folders = (nodes: ReturnType<typeof buildBranchTree>): BranchTreeFolder[] =>
  nodes.filter((n): n is BranchTreeFolder => n.type === "folder");

describe("buildBranchTree", () => {
  it("returns an empty array for no branches", () => {
    expect(buildBranchTree([], null)).toEqual([]);
  });

  it("renders flat branches as leaves, with the head marked", () => {
    const tree = buildBranchTree(["main", "feature-x"], "main");
    expect(folders(tree)).toHaveLength(0);
    const names = leaves(tree).map((l) => l.name);
    expect(names).toEqual(["main", "feature-x"]); // primary branch first
    const main = leaves(tree).find((l) => l.name === "main")!;
    expect(main.isHead).toBe(true);
    expect(main.isRemote).toBe(false);
  });

  it("groups slash-separated names into folders", () => {
    const tree = buildBranchTree(["main", "feature/login"], null);
    const feature = folders(tree).find((f) => f.name === "feature");
    expect(feature).toBeDefined();
    expect(feature!.path).toBe("feature");
    const child = feature!.children[0] as BranchTreeLeaf;
    expect(child.type).toBe("leaf");
    expect(child.name).toBe("login");
    expect(child.branch).toBe("feature/login"); // full ref preserved
  });

  it("nests multi-segment names and tracks folder paths", () => {
    const tree = buildBranchTree(["team/feat/bar"], null);
    const team = folders(tree)[0];
    expect(team.name).toBe("team");
    const feat = folders(team.children)[0];
    expect(feat.name).toBe("feat");
    expect(feat.path).toBe("team/feat");
    expect((feat.children[0] as BranchTreeLeaf).name).toBe("bar");
  });

  it("strips the remotes/ prefix for display but keeps it on the ref", () => {
    const tree = buildBranchTree(["remotes/origin/main"], null);
    const origin = folders(tree).find((f) => f.name === "origin")!;
    const leaf = origin.children[0] as BranchTreeLeaf;
    expect(leaf.name).toBe("main");
    expect(leaf.branch).toBe("remotes/origin/main");
    expect(leaf.isRemote).toBe(true);
  });

  it("orders primary branches first, then alphabetical, folders after leaves", () => {
    const tree = buildBranchTree(["zeta", "develop", "alpha", "feature/x"], null);
    expect(leaves(tree).map((l) => l.name)).toEqual(["develop", "alpha", "zeta"]);
    // folder comes after all sibling leaves
    expect(tree[tree.length - 1].type).toBe("folder");
  });

  it("defaults leaves to active with no last-activity time", () => {
    const leaf = leaves(buildBranchTree(["main"], "main"))[0];
    expect(leaf.isInactive).toBe(false);
    expect(leaf.lastActivitySec).toBeUndefined();
  });

  it("tags inactive leaves and carries the last-activity time from meta", () => {
    const tree = buildBranchTree(["main", "stale"], "main", {
      inactive: new Set(["stale"]),
      dates: { main: 100, stale: 50 }
    });
    const main = leaves(tree).find((l) => l.name === "main")!;
    const stale = leaves(tree).find((l) => l.name === "stale")!;
    expect(main.isInactive).toBe(false);
    expect(stale.isInactive).toBe(true);
    expect(stale.lastActivitySec).toBe(50);
  });

  it("tags an inactive leaf nested inside a folder", () => {
    const tree = buildBranchTree(["feature/old"], null, {
      inactive: new Set(["feature/old"]),
      dates: { "feature/old": 50 }
    });
    const feature = folders(tree).find((f) => f.name === "feature")!;
    expect((feature.children[0] as BranchTreeLeaf).isInactive).toBe(true);
  });
});

describe("buildGroupedBranchRoots", () => {
  it("returns an empty array for no branches", () => {
    expect(buildGroupedBranchRoots([], null)).toEqual([]);
  });

  it("stays flat (no group headings) when there are no remote branches", () => {
    const roots = buildGroupedBranchRoots(["main", "feature/login"], "main");
    expect(roots).toEqual(buildBranchTree(["main", "feature/login"], "main"));
    expect(roots.some((n) => n.type === "group")).toBe(false);
  });

  it("splits into a remote group followed by a local group", () => {
    const roots = buildGroupedBranchRoots(
      ["main", "feature/login", "remotes/origin/main", "remotes/origin/feature/login"],
      "main"
    );
    expect(roots.map((n) => n.type)).toEqual(["group", "group"]);
    const [remote, local] = roots as BranchTreeGroup[];
    expect(remote.kind).toBe("remote");
    expect(local.kind).toBe("local");

    // Remote children keep the per-remote folder layer (origin > …).
    const origin = folders(remote.children).find((f) => f.name === "origin")!;
    expect(origin).toBeDefined();
    expect((origin.children[0] as BranchTreeLeaf).branch).toBe("remotes/origin/main");

    // Local children are the usual leaf/folder mix, head marked.
    const main = leaves(local.children).find((l) => l.name === "main")!;
    expect(main.isHead).toBe(true);
    expect(local.children.some((n) => n.type === "folder" && n.name === "feature")).toBe(true);
  });

  it("passes inactivity meta through to both groups", () => {
    const roots = buildGroupedBranchRoots(["main", "stale", "remotes/origin/old"], "main", {
      inactive: new Set(["stale", "remotes/origin/old"]),
      dates: { stale: 50, "remotes/origin/old": 40 }
    }) as BranchTreeGroup[];
    const remoteLeaf = folders(roots[0].children)[0].children[0] as BranchTreeLeaf;
    expect(remoteLeaf.isInactive).toBe(true);
    expect(remoteLeaf.lastActivitySec).toBe(40);
    const stale = leaves(roots[1].children).find((l) => l.name === "stale")!;
    expect(stale.isInactive).toBe(true);
  });
});
