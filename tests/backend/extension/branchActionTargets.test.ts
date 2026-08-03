import { describe, expect, it } from "vitest";

import { resolveActionTargets } from "@/extension/branchActionTargets";
import { buildGroupedBranchRoots } from "@/extension/branchTree";

describe("resolveActionTargets", () => {
  it("returns the selected leaves in tree order, ignoring folder and group nodes", () => {
    const roots = buildGroupedBranchRoots(["remotes/origin/main", "main", "feature/login"], "main");
    // Deliberately scrambled: the caller hands us VSCode's selection array,
    // whose order carries no guarantee.
    const { targets } = resolveActionTargets(
      roots,
      ["feature/login", "main", "remotes/origin/main"],
      "copyName"
    );
    expect(targets.map((t) => t.branch)).toEqual(["remotes/origin/main", "main", "feature/login"]);
  });

  it("skips the checked-out branch for delete, and reports it rather than dropping it silently", () => {
    const roots = buildGroupedBranchRoots(["main", "feature/a"], "main");
    const { targets, skipped } = resolveActionTargets(roots, ["main", "feature/a"], "delete");
    expect(targets.map((t) => t.branch)).toEqual(["feature/a"]);
    expect(skipped.map((s) => [s.leaf.branch, s.reason])).toEqual([["main", "checkedOut"]]);
  });

  it("skips remote branches for push", () => {
    const roots = buildGroupedBranchRoots(["remotes/origin/feature", "feature"], "main");
    const { targets, skipped } = resolveActionTargets(
      roots,
      ["remotes/origin/feature", "feature"],
      "push"
    );
    expect(targets.map((t) => t.branch)).toEqual(["feature"]);
    expect(skipped.map((s) => [s.leaf.branch, s.reason])).toEqual([
      ["remotes/origin/feature", "remote"]
    ]);
  });

  it("skips both remote and checked-out branches for fast-forward", () => {
    const roots = buildGroupedBranchRoots(["remotes/origin/x", "main", "feature"], "main");
    const { targets, skipped } = resolveActionTargets(
      roots,
      ["remotes/origin/x", "main", "feature"],
      "fastForward"
    );
    expect(targets.map((t) => t.branch)).toEqual(["feature"]);
    expect(skipped.map((s) => [s.leaf.branch, s.reason])).toEqual([
      ["remotes/origin/x", "remote"],
      ["main", "checkedOut"]
    ]);
  });

  // Pins the negative space: the skip rules exist to stop git from being handed
  // an impossible operation, and copying a name is never impossible. Without
  // this, a later "skip the checked-out branch everywhere" tidy-up would quietly
  // make the current branch uncopyable.
  it("skips nothing for copy name, including remote and checked-out branches", () => {
    const roots = buildGroupedBranchRoots(["remotes/origin/x", "main"], "main");
    const { targets, skipped } = resolveActionTargets(
      roots,
      ["remotes/origin/x", "main"],
      "copyName"
    );
    expect(targets.map((t) => t.branch)).toEqual(["remotes/origin/x", "main"]);
    expect(skipped).toEqual([]);
  });
});
