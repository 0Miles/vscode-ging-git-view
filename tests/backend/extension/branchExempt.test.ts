import { describe, expect, it } from "vitest";

import {
  branchGlobMatches,
  isAlwaysShown,
  isExempt,
  withExemptions
} from "@/extension/branchExempt";

describe("branchGlobMatches", () => {
  it("matches an exact name", () => {
    expect(branchGlobMatches("main", "main")).toBe(true);
    expect(branchGlobMatches("maine", "main")).toBe(false);
  });

  it("supports * over a path segment", () => {
    expect(branchGlobMatches("release/1.2", "release/*")).toBe(true);
    expect(branchGlobMatches("release/", "release/*")).toBe(true); // * matches empty
    expect(branchGlobMatches("feature/x", "release/*")).toBe(false);
  });

  it("collapses runs of * (no catastrophic backtracking)", () => {
    expect(branchGlobMatches("release/1.2", "release/****")).toBe(true);
    // A pathological pattern against a non-matching name must return quickly.
    expect(branchGlobMatches("a".repeat(50) + "!", "*".repeat(40) + "b")).toBe(false);
  });

  it("supports ? for a single char and treats other metachars literally", () => {
    expect(branchGlobMatches("v1", "v?")).toBe(true);
    expect(branchGlobMatches("v12", "v?")).toBe(false);
    expect(branchGlobMatches("a.b", "a.b")).toBe(true);
    expect(branchGlobMatches("axb", "a.b")).toBe(false); // '.' is literal, not regex
  });
});

describe("isAlwaysShown", () => {
  it("exempts a remote branch by its bare and remote-qualified name", () => {
    expect(isAlwaysShown("remotes/origin/main", ["main"])).toBe(true);
    expect(isAlwaysShown("remotes/origin/main", ["origin/main"])).toBe(true);
    expect(isAlwaysShown("remotes/origin/main", ["remotes/origin/main"])).toBe(true);
    expect(isAlwaysShown("remotes/origin/feature", ["main"])).toBe(false);
  });

  it("matches glob patterns against the bare remote name", () => {
    expect(isAlwaysShown("remotes/origin/release/9", ["release/*"])).toBe(true);
  });
});

describe("isExempt", () => {
  const exemptions = { head: "main", selected: ["picked"], patterns: ["keep"] };

  it("exempts the head, the selection and the always-show patterns", () => {
    expect(isExempt("main", exemptions)).toBe(true);
    expect(isExempt("picked", exemptions)).toBe(true);
    expect(isExempt("keep", exemptions)).toBe(true);
    expect(isExempt("other", exemptions)).toBe(false);
  });

  it("exempts nothing extra when detached and nothing is selected", () => {
    expect(isExempt("main", { head: null, selected: [], patterns: [] })).toBe(false);
  });
});

describe("withExemptions", () => {
  it("keeps the fact set intact and narrows only the hidable one", () => {
    const matched = new Set(["main", "picked", "keep", "other"]);
    const result = withExemptions(matched, {
      head: "main",
      selected: ["picked"],
      patterns: ["keep"]
    });
    // The fact is reported for every branch — this is what drives the markings.
    expect([...result.matched].toSorted()).toEqual(["keep", "main", "other", "picked"]);
    // Only the non-exempt one may be dimmed and hidden.
    expect([...result.hidable]).toEqual(["other"]);
  });
});
