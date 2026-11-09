import { describe, expect, it } from "vitest";

import {
  branchFilterEquals,
  computeDefaultBranchFilter,
  pruneBranchFilter,
  resolveBranchFilter
} from "@/extension/branchFilter";

describe("branchFilterEquals", () => {
  it("is order-insensitive", () => {
    expect(branchFilterEquals(["a", "b"], ["b", "a"])).toBe(true);
    expect(branchFilterEquals([], [])).toBe(true);
  });
  it("distinguishes different selections", () => {
    expect(branchFilterEquals(["a"], ["a", "b"])).toBe(false);
    expect(branchFilterEquals(["a"], ["b"])).toBe(false);
  });
});

describe("pruneBranchFilter", () => {
  it("drops refs that no longer exist, preserving order", () => {
    expect(pruneBranchFilter(["main", "gone", "dev"], ["dev", "main"])).toEqual(["main", "dev"]);
  });
  it("returns an empty array when nothing survives", () => {
    expect(pruneBranchFilter(["a", "b"], ["c"])).toEqual([]);
  });
});

const opts = (showSpecificBranches: string[], showCurrentBranchByDefault: boolean) => ({
  showSpecificBranches,
  showCurrentBranchByDefault
});

describe("computeDefaultBranchFilter", () => {
  it("returns empty (show all) when nothing is configured", () => {
    expect(computeDefaultBranchFilter(["main"], "main", opts([], false))).toEqual([]);
  });
  it("includes configured specific branches that exist", () => {
    expect(
      computeDefaultBranchFilter(["main", "dev"], "main", opts(["dev", "ghost"], false))
    ).toEqual(["dev"]);
  });
  it("adds the checked-out branch when enabled, without duplicates", () => {
    expect(computeDefaultBranchFilter(["main", "dev"], "main", opts(["main"], true))).toEqual([
      "main"
    ]);
    expect(computeDefaultBranchFilter(["main", "dev"], "dev", opts(["main"], true))).toEqual([
      "main",
      "dev"
    ]);
  });
});

describe("resolveBranchFilter", () => {
  const showAllOpts = { showSpecificBranches: [], showCurrentBranchByDefault: false };

  it("computes the default when no selection exists yet", () => {
    expect(resolveBranchFilter(undefined, ["main"], "main", showAllOpts)).toEqual([]);
    expect(
      resolveBranchFilter(undefined, ["main", "dev"], "dev", {
        showSpecificBranches: [],
        showCurrentBranchByDefault: true
      })
    ).toEqual(["dev"]);
  });
  it("keeps a still-valid selection, pruning missing refs", () => {
    expect(resolveBranchFilter(["main", "gone"], ["main", "dev"], "main", showAllOpts)).toEqual([
      "main"
    ]);
  });
  it("preserves an explicit empty selection (Show All) over the configured default", () => {
    expect(
      resolveBranchFilter([], ["main", "dev"], "dev", {
        showSpecificBranches: ["dev"],
        showCurrentBranchByDefault: true
      })
    ).toEqual([]);
  });
  it("falls back to the default when the selection is fully pruned away", () => {
    expect(
      resolveBranchFilter(["gone"], ["main"], "main", {
        showSpecificBranches: [],
        showCurrentBranchByDefault: true
      })
    ).toEqual(["main"]);
  });
});
