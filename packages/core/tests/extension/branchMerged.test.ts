import { describe, expect, it } from "vitest";

import { classifyMerged } from "@/extension/branchMerged";

const noExemptions = { head: null, selected: [] as string[], patterns: [] as string[] };

describe("classifyMerged", () => {
  it("reports the branches git listed as merged", () => {
    const result = classifyMerged({
      branches: ["main", "done", "wip"],
      merged: ["main", "done"],
      defaultBranch: "main",
      exemptions: noExemptions
    });
    expect([...result.matched]).toEqual(["done"]);
  });

  it("never reports the default branch or its local counterpart", () => {
    // `--merged=remotes/origin/main` always returns the default branch itself,
    // and the local `main` alongside it whenever the two are in sync. Reporting
    // it as merged into itself is a tautology, not information.
    const result = classifyMerged({
      branches: ["main", "remotes/origin/main", "done"],
      merged: ["main", "remotes/origin/main", "done"],
      defaultBranch: "remotes/origin/main",
      exemptions: noExemptions
    });
    expect([...result.matched]).toEqual(["done"]);
  });

  it("classifies remote-tracking branches too", () => {
    const result = classifyMerged({
      branches: ["main", "remotes/origin/main", "remotes/origin/done"],
      merged: ["remotes/origin/main", "remotes/origin/done"],
      defaultBranch: "remotes/origin/main",
      exemptions: noExemptions
    });
    expect([...result.matched]).toEqual(["remotes/origin/done"]);
  });

  it("ignores refs git reported that the view isn't listing", () => {
    // `for-each-ref --merged` is read separately from the branch list; only refs
    // present in both can be marked. This is also the backstop against a stray
    // `refs/remotes/origin/HEAD` leaking through as a phantom `origin` entry.
    const result = classifyMerged({
      branches: ["main", "done"],
      merged: ["main", "done", "origin", "vanished"],
      defaultBranch: "main",
      exemptions: noExemptions
    });
    expect([...result.matched]).toEqual(["done"]);
  });

  it("marks exempt branches but never makes them hidable", () => {
    // The whole point of splitting the two sets: standing on an already-merged
    // branch is the single most actionable signal this feature produces, and it
    // must survive the head being exempt from hiding.
    const result = classifyMerged({
      branches: ["main", "feature", "picked", "keep", "done"],
      merged: ["feature", "picked", "keep", "done"],
      defaultBranch: "main",
      exemptions: { head: "feature", selected: ["picked"], patterns: ["keep"] }
    });
    expect([...result.matched].toSorted()).toEqual(["done", "feature", "keep", "picked"]);
    expect([...result.hidable]).toEqual(["done"]);
  });

  it("classifies nothing when no default branch could be resolved", () => {
    const result = classifyMerged({
      branches: ["feature-a", "feature-b"],
      merged: ["feature-a"],
      defaultBranch: null,
      exemptions: noExemptions
    });
    expect(result.matched.size).toBe(0);
    expect(result.hidable.size).toBe(0);
  });
});
