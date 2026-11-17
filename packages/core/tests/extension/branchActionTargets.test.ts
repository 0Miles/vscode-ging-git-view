import { describe, expect, it } from "vitest";

import {
  actionTargetRefs,
  planBatch,
  resolveActionTargets
} from "@ging/shared/backend/utils/branchActionTargets";
import { buildGroupedBranchRoots } from "@ging/shared/backend/utils/branchTree";
import {
  CATALOGUE_REF_ACTIONS,
  headGuardBlocks,
  REF_ACTION_CATALOGUE,
  refKindsAdmit
} from "@ging/shared/backend/utils/refActionCatalogue";

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

// The batch decision and the head guard both hosts run (ADR-0033): VS Code's
// delegate and the desktop side view each carry out the plan, but neither
// decides it.
describe("planBatch", () => {
  const roots = buildGroupedBranchRoots(["main", "a", "remotes/origin/x"], "main");
  const plan = (action: Parameters<typeof planBatch>[0], selected: string[]) =>
    planBatch(action, actionTargetRefs("/repo", resolveActionTargets(roots, selected, action)));

  it("hands the graph its targets in tree order, with the skipped ones named", () => {
    expect(plan("fastForward", ["a", "remotes/origin/x"])).toEqual({
      kind: "graph",
      action: "fastForward",
      repo: "/repo",
      targets: ["a"],
      skipped: [{ ref: "remotes/origin/x", reason: "remote" }]
    });
  });

  it("names the skipped branches when nothing is left to act on", () => {
    expect(plan("delete", ["main"])).toEqual({
      kind: "noTargets",
      skipped: [{ ref: "main", reason: "checkedOut" }]
    });
  });

  it("runs an action that asks nothing in the host, and does nothing without targets", () => {
    expect(plan("copyName", ["main", "remotes/origin/x"])).toEqual({
      kind: "host",
      action: "copyName",
      targets: ["remotes/origin/x", "main"]
    });
    expect(plan("copyName", [])).toEqual({ kind: "none" });
  });
});

describe("headGuardBlocks and refKindsAdmit", () => {
  it("block exactly the head-guarded actions, and only on the checked-out branch", () => {
    for (const action of CATALOGUE_REF_ACTIONS) {
      expect(headGuardBlocks(action, { isHead: true }), action).toBe(
        REF_ACTION_CATALOGUE[action].headGuard
      );
      expect(headGuardBlocks(action, { isHead: false }), action).toBe(false);
    }
  });

  it("admit a ref of the kinds the catalogue declares", () => {
    expect(refKindsAdmit("rename", false)).toBe(true);
    expect(refKindsAdmit("rename", true)).toBe(false);
    expect(refKindsAdmit("pull", false)).toBe(false);
    expect(refKindsAdmit("checkout", true)).toBe(true);
  });
});
