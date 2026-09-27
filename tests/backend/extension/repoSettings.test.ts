import { describe, expect, it } from "vitest";

import { resolveRepoScope, sideViewStateChanged } from "@/extension/repoSettings";
import type { RepoScopeSettings } from "@/types";

const DEFAULTS: RepoScopeSettings = {
  onlyFollowFirstParent: false,
  includeReflogCommits: false,
  showStashes: true,
  showTagOnlyCommits: true,
  showRemoteHeads: true
};

describe("resolveRepoScope", () => {
  it("gives a repo the manager does not hold the global settings", () => {
    expect(resolveRepoScope(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("lets each override win over its own global setting, and only that one", () => {
    expect(
      resolveRepoScope(
        { columnWidths: null, onlyFollowFirstParent: true, showStashes: false },
        DEFAULTS
      )
    ).toEqual({ ...DEFAULTS, onlyFollowFirstParent: true, showStashes: false });
  });

  it("reads an explicit false as an override, not as unset", () => {
    // The global setting is true; a falsy-check resolver would fall through to it.
    expect(
      resolveRepoScope({ columnWidths: null, showRemoteHeads: false }, DEFAULTS).showRemoteHeads
    ).toBe(false);
  });

  it("reads null as unset", () => {
    expect(resolveRepoScope({ columnWidths: null, includeReflogCommits: null }, DEFAULTS)).toEqual(
      DEFAULTS
    );
  });
});

describe("sideViewStateChanged", () => {
  it("ignores a write that moved none of the side-view's fields", () => {
    expect(
      sideViewStateChanged(
        { columnWidths: null, showMergedBranches: true },
        { columnWidths: [10, 20], showMergedBranches: true, onlyFollowFirstParent: true }
      )
    ).toBe(false);
  });

  it.each(["showRemoteBranches", "showInactiveBranches", "showMergedBranches"] as const)(
    "notices %s moving",
    (field) => {
      expect(
        sideViewStateChanged({ columnWidths: null }, { columnWidths: null, [field]: true })
      ).toBe(true);
    }
  );

  it("treats a missing field and an explicit null as the same thing", () => {
    expect(
      sideViewStateChanged(
        { columnWidths: null },
        { columnWidths: null, showInactiveBranches: null }
      )
    ).toBe(false);
  });

  it("notices a repo the manager did not hold arriving with an override", () => {
    expect(sideViewStateChanged(undefined, { columnWidths: null, showRemoteBranches: false })).toBe(
      true
    );
  });
});
