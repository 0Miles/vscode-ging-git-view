import { describe, expect, it } from "vitest";

import {
  branchGlobMatches,
  classifyInactive,
  isAlwaysShown,
  relativeAge
} from "@/extension/branchActivity";

const DAY = 86_400;
const NOW = 1_700_000_000; // fixed "now" so the tests are deterministic

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

describe("classifyInactive", () => {
  const base = {
    head: "main" as string | null,
    nowSec: NOW,
    thresholdDays: 30,
    exemptPatterns: ["main"],
    selected: [] as string[]
  };

  it("flags branches older than the threshold", () => {
    const result = classifyInactive({
      ...base,
      branches: ["main", "old", "fresh"],
      dates: { main: NOW, old: NOW - 40 * DAY, fresh: NOW - 5 * DAY }
    });
    expect([...result]).toEqual(["old"]);
  });

  it("never flags the head, selected, or always-show branches", () => {
    const result = classifyInactive({
      ...base,
      selected: ["picked"],
      exemptPatterns: ["main", "keep"],
      branches: ["main", "picked", "keep", "old"],
      dates: {
        main: NOW - 99 * DAY,
        picked: NOW - 99 * DAY,
        keep: NOW - 99 * DAY,
        old: NOW - 99 * DAY
      }
    });
    expect([...result]).toEqual(["old"]);
  });

  it("keeps branches whose age is unknown (no date entry)", () => {
    const result = classifyInactive({
      ...base,
      branches: ["main", "mystery"],
      dates: { main: NOW }
    });
    expect(result.size).toBe(0);
  });

  it("disables classification when the threshold is 0 or negative", () => {
    const result = classifyInactive({
      ...base,
      thresholdDays: 0,
      branches: ["main", "ancient"],
      dates: { main: NOW, ancient: NOW - 9999 * DAY }
    });
    expect(result.size).toBe(0);
  });

  it("treats a branch exactly at the cutoff as still active", () => {
    const result = classifyInactive({
      ...base,
      branches: ["main", "edge"],
      dates: { main: NOW, edge: NOW - 30 * DAY }
    });
    expect(result.has("edge")).toBe(false);
  });
});

describe("relativeAge", () => {
  it("yields days, weeks, months and years, rounding down", () => {
    expect(relativeAge(NOW, NOW)).toEqual({ value: 0, unit: "day" });
    expect(relativeAge(NOW - 6 * DAY, NOW)).toEqual({ value: 6, unit: "day" });
    expect(relativeAge(NOW - 13 * DAY, NOW)).toEqual({ value: 1, unit: "week" });
    expect(relativeAge(NOW - 60 * DAY, NOW)).toEqual({ value: 2, unit: "month" });
    expect(relativeAge(NOW - 800 * DAY, NOW)).toEqual({ value: 2, unit: "year" });
  });

  it("clamps a future timestamp to zero days", () => {
    expect(relativeAge(NOW + 5 * DAY, NOW)).toEqual({ value: 0, unit: "day" });
  });
});
