import { describe, expect, it } from "vitest";

import { resolveCleanupCandidates } from "@/extension/branchCleanup";

/** A classification whose fact set and hidable set agree — the ordinary case,
 *  where nothing is exempt from hiding. */
function classified(matched: string[]) {
  return { matched: new Set(matched), hidable: new Set(matched) };
}

const nothing = classified([]);

describe("resolveCleanupCandidates", () => {
  it("proposes the union of the three facts", () => {
    const result = resolveCleanupCandidates({
      branches: ["main", "merged-only", "inactive-only", "redundant-only", "clean"],
      head: "main",
      defaultBranch: "main",
      dates: {},
      merged: classified(["merged-only"]),
      inactive: classified(["inactive-only"]),
      redundant: new Set(["redundant-only"]),
      patterns: []
    });
    expect(result.candidates.map((c) => c.ref).toSorted()).toEqual([
      "inactive-only",
      "merged-only",
      "redundant-only"
    ]);
  });

  it("never proposes the checked-out branch, the default branch or its local twin", () => {
    // Deleting the checked-out branch is impossible, and the default branch is
    // the basis every verdict was measured against — proposing either is a bug,
    // not a risk the user should have to notice in the list.
    const result = resolveCleanupCandidates({
      branches: ["main", "remotes/origin/main", "feature", "done"],
      head: "feature",
      defaultBranch: "remotes/origin/main",
      dates: {},
      merged: classified(["main", "remotes/origin/main", "feature", "done"]),
      inactive: nothing,
      patterns: []
    });
    expect(result.candidates.map((c) => c.ref)).toEqual(["done"]);
  });

  it("never proposes a branch the user marked always-show", () => {
    // `branches.alwaysShow` defaults to the mainline names, and adding to it is
    // a user-authored "stop bothering me about these" — the same intent applies
    // to being offered for deletion.
    const result = resolveCleanupCandidates({
      branches: ["main", "release/1.x", "remotes/origin/release/2.x", "done"],
      head: "main",
      defaultBranch: "main",
      dates: {},
      merged: classified(["release/1.x", "remotes/origin/release/2.x", "done"]),
      inactive: nothing,
      patterns: ["release/*"]
    });
    expect(result.candidates.map((c) => c.ref)).toEqual(["done"]);
  });

  it("still proposes a branch the filter exempted from hiding", () => {
    // The one exemption `hidable` has that candidacy does not. The filter often
    // holds exactly the branches about to be deleted (ADR-0008), so reading the
    // hidable set here would hide them from the dialog that lists them.
    const result = resolveCleanupCandidates({
      branches: ["main", "selected", "done"],
      head: "main",
      defaultBranch: "main",
      dates: {},
      merged: { matched: new Set(["selected", "done"]), hidable: new Set(["done"]) },
      inactive: nothing,
      patterns: []
    });
    expect(result.candidates.map((c) => c.ref).toSorted()).toEqual(["done", "selected"]);
  });

  it("lists candidates in the branch tree's order, not git's", () => {
    // The order the user already knows from the side-view: the remote group
    // first, mainline names before the rest, folders after the leaves beside
    // them. Also what the batch summary folds results back into.
    const branches = [
      "alpha",
      "remotes/origin/zeta",
      "feature/x",
      "develop",
      "remotes/origin/beta"
    ];
    const result = resolveCleanupCandidates({
      branches,
      head: null,
      defaultBranch: "main",
      dates: {},
      merged: classified(branches),
      inactive: nothing,
      patterns: []
    });
    expect(result.candidates.map((c) => c.ref)).toEqual([
      "remotes/origin/beta",
      "remotes/origin/zeta",
      "develop",
      "alpha",
      "feature/x"
    ]);
  });

  it("carries each row's facts, remote-ness and last activity", () => {
    // Every row states which facts put it there — the safety strengths differ
    // wildly, so a row that only says "candidate" would flatten merged's git
    // guarantee and inactive's silence about content into one claim.
    const result = resolveCleanupCandidates({
      branches: ["main", "remotes/origin/done", "old"],
      head: "main",
      defaultBranch: "main",
      dates: { "remotes/origin/done": 1_700_000_000, old: 1_600_000_000 },
      merged: classified(["remotes/origin/done"]),
      inactive: classified(["old"]),
      redundant: new Set(["remotes/origin/done"]),
      patterns: []
    });
    expect(result.candidates).toEqual([
      {
        ref: "remotes/origin/done",
        isRemote: true,
        facts: { merged: true, redundant: true, inactive: false },
        lastActivitySec: 1_700_000_000
      },
      {
        ref: "old",
        isRemote: false,
        facts: { merged: false, redundant: false, inactive: true },
        lastActivitySec: 1_600_000_000
      }
    ]);
  });

  it("offers the deep check every branch not already known merged", () => {
    // Not just the listed candidates: a branch squash-merged yesterday is
    // neither merged (ancestry fails) nor inactive (the commit is new), so it is
    // absent from the list and only a scan of everything else can surface it.
    // The merged ones are skipped because every merged branch is redundant
    // already — the answer is known (CONTEXT.md).
    const result = resolveCleanupCandidates({
      branches: ["main", "merged-done", "wip", "remotes/origin/wip", "release/1.x"],
      head: "main",
      defaultBranch: "main",
      dates: {},
      merged: classified(["merged-done"]),
      inactive: nothing,
      patterns: ["release/*"]
    });
    expect(result.scannable).toEqual(["remotes/origin/wip", "wip"]);
  });

  it("falls back to inactive alone when no default branch resolved", () => {
    // Default branch is the sole basis for merged and redundant alike, so both
    // are unanswerable. The dialog reports that rather than silently showing a
    // short list: it is an on-demand query, and CONTEXT.md reserves silent
    // disabling for the passive display.
    const result = resolveCleanupCandidates({
      branches: ["main", "was-merged", "old"],
      head: null,
      defaultBranch: null,
      dates: { old: 1_600_000_000 },
      merged: classified([]),
      inactive: classified(["old"]),
      patterns: []
    });
    expect(result.candidates.map((c) => c.ref)).toEqual(["old"]);
    expect(result.defaultBranch).toBeNull();
    // Nothing to compare against, so the deep check has nothing it could ask.
    expect(result.scannable).toEqual([]);
  });
});
