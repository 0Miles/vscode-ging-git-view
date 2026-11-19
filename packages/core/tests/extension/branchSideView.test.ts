import { describe, expect, it } from "vitest";

import type { BranchFactsResult } from "@ging/core/extension/branchFacts";
import {
  batchNoTargetsMessage,
  resolveSideViewToggle,
  sideViewBranchRoots,
  sideViewSearchGroups
} from "@ging/core/extension/branchSideView";
import type { BranchTreeLeaf, BranchTreeNode } from "@ging/shared/backend/utils/branchTree";

function leaves(nodes: readonly BranchTreeNode[]): BranchTreeLeaf[] {
  return nodes.flatMap((n) => (n.type === "leaf" ? [n] : leaves(n.children)));
}

/** A repo of five branches: `main` checked out and the default branch, `done`
 *  merged, `old` inactive, `kept` merged but selected in the branch filter
 *  (so exempt from hiding, not from cleanup), `work` neither. */
function facts(overrides: Partial<BranchFactsResult> = {}): BranchFactsResult {
  return {
    branches: ["main", "done", "old", "kept", "work"],
    head: "main",
    isRepo: true,
    defaultBranch: "main",
    dates: { old: 1_000 },
    filter: ["kept"],
    merged: { matched: new Set(["done", "kept"]), hidable: new Set(["done"]) },
    inactive: { matched: new Set(["old"]), hidable: new Set(["old"]) },
    hidable: new Set(["done", "old"]),
    ...overrides
  };
}

const showBoth = { showInactive: true, showMerged: true };

describe("sideViewBranchRoots", () => {
  it("lists every branch while both toggles show, dimming the hidable ones", () => {
    const rows = leaves(sideViewBranchRoots(facts(), showBoth, []));
    expect(rows.map((l) => l.branch).toSorted()).toEqual(["done", "kept", "main", "old", "work"]);
    expect(
      rows
        .filter((l) => l.isHidable)
        .map((l) => l.branch)
        .toSorted()
    ).toEqual(["done", "old"]);
  });

  it("drops what either toggle hides, whatever the other says", () => {
    const noInactive = leaves(
      sideViewBranchRoots(facts(), { showInactive: false, showMerged: true }, [])
    );
    expect(noInactive.map((l) => l.branch)).not.toContain("old");
    expect(noInactive.map((l) => l.branch)).toContain("done");

    const noMerged = leaves(
      sideViewBranchRoots(facts(), { showInactive: true, showMerged: false }, [])
    );
    expect(noMerged.map((l) => l.branch)).not.toContain("done");
    // Merged, but exempt from hiding: the filter holds it.
    expect(noMerged.map((l) => l.branch)).toContain("kept");
  });

  it("marks the facts on exempt branches too: the badge, not the grey", () => {
    const kept = leaves(sideViewBranchRoots(facts(), showBoth, [])).find(
      (l) => l.branch === "kept"
    );
    expect(kept).toMatchObject({ isMerged: true, isHidable: false });
  });

  it("marks the cleanup candidates, which the branch filter does not exempt", () => {
    const rows = leaves(sideViewBranchRoots(facts(), showBoth, []));
    expect(
      rows
        .filter((l) => l.isCleanupCandidate)
        .map((l) => l.branch)
        .toSorted()
    ).toEqual(["done", "kept", "old"]);
    // "Always show" exempts from cleanup.
    const exempt = leaves(sideViewBranchRoots(facts(), showBoth, ["old"]));
    expect(exempt.find((l) => l.branch === "old")?.isCleanupCandidate).toBe(false);
  });

  it("lists nothing for a path that is no repository", () => {
    expect(sideViewBranchRoots(facts({ isRepo: false }), showBoth, [])).toEqual([]);
  });
});

describe("resolveSideViewToggle", () => {
  it("takes the repo's override over the global default, and the default without one", () => {
    expect(
      resolveSideViewToggle(
        { columnWidths: null, showMergedBranches: false },
        "showMergedBranches",
        true
      )
    ).toBe(false);
    expect(resolveSideViewToggle({ columnWidths: null }, "showMergedBranches", true)).toBe(true);
    expect(resolveSideViewToggle(undefined, "showInactiveBranches", false)).toBe(false);
  });
});

/** A leaf as the tree lists `branch`. */
const leaf = (branch: string, isHead = false): BranchTreeLeaf => ({
  type: "leaf",
  branch,
  name: branch.split("/").at(-1)!,
  isHead,
  isRemote: branch.startsWith("remotes/"),
  isMerged: false,
  isInactive: false,
  isHidable: false,
  isCleanupCandidate: false
});

/** What Search Branch's runs list, each row as `branch[*current][+picked]`. */
const shown = (groups: ReturnType<typeof sideViewSearchGroups>) =>
  groups.map(({ group, named, items }) => ({
    group,
    named,
    items: items.map(
      ({ leaf: l, current, picked }) => l.branch + (current ? "*" : "") + (picked ? "+" : "")
    )
  }));

describe("sideViewSearchGroups", () => {
  it("lists the tree's leaves, remote ones first, each run named when there are both", () => {
    const roots: BranchTreeNode[] = [
      {
        type: "group",
        kind: "local",
        children: [
          leaf("main", true),
          {
            type: "folder",
            name: "feature",
            path: "feature",
            children: [leaf("feature/a"), leaf("feature/b")]
          }
        ]
      },
      {
        type: "group",
        kind: "remote",
        children: [
          {
            type: "folder",
            name: "origin",
            path: "origin",
            children: [leaf("remotes/origin/main"), leaf("remotes/origin/dev")]
          }
        ]
      }
    ];
    expect(shown(sideViewSearchGroups(roots, ["feature/b", "remotes/origin/dev", "gone"]))).toEqual(
      [
        { group: "remote", named: true, items: ["remotes/origin/main", "remotes/origin/dev+"] },
        { group: "local", named: true, items: ["main*", "feature/a", "feature/b+"] }
      ]
    );
  });

  it("leaves out an empty run and names neither, and offers nothing for an empty tree", () => {
    expect(shown(sideViewSearchGroups([leaf("main", true), leaf("topic")], ["main"]))).toEqual([
      { group: "local", named: false, items: ["main*+", "topic"] }
    ]);
    expect(shown(sideViewSearchGroups([leaf("remotes/origin/main")], []))).toEqual([
      { group: "remote", named: false, items: ["remotes/origin/main"] }
    ]);
    expect(sideViewSearchGroups([], ["main"])).toEqual([]);
  });
});

describe("batchNoTargetsMessage", () => {
  it("names each skipped branch by its display ref, under its reason", () => {
    const l10n = { t: (key: string, ...args: unknown[]) => [key, ...args].join("|") };
    expect(
      batchNoTargetsMessage(l10n, [
        { ref: "main", reason: "checkedOut" },
        { ref: "remotes/origin/a", reason: "remote" },
        { ref: "remotes/origin/b", reason: "remote" }
      ])
    ).toBe(
      "branchView.batch.noTargets dialog.batch.skippedCheckedOut|main dialog.batch.skippedRemote|origin/a, origin/b"
    );
  });
});
