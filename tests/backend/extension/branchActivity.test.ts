import { describe, expect, it } from "vitest";

import { classifyInactive, relativeAge } from "@/extension/branchActivity";

const DAY = 86_400;
const NOW = 1_700_000_000; // fixed "now" so the tests are deterministic

describe("classifyInactive", () => {
  const base = {
    nowSec: NOW,
    thresholdDays: 30,
    exemptions: { head: "main", selected: [] as string[], patterns: ["main"] }
  };

  it("flags branches older than the threshold", () => {
    const result = classifyInactive({
      ...base,
      branches: ["main", "old", "fresh"],
      dates: { main: NOW, old: NOW - 40 * DAY, fresh: NOW - 5 * DAY }
    });
    expect([...result.matched]).toEqual(["old"]);
    expect([...result.hidable]).toEqual(["old"]);
  });

  it("still reports the head, selected and always-show branches as inactive", () => {
    // The fact is unconditional — that is what puts an age label on `main` and
    // on the branch you're standing on. Only `hidable` honours the exemptions.
    const result = classifyInactive({
      ...base,
      exemptions: { head: "main", selected: ["picked"], patterns: ["main", "keep"] },
      branches: ["main", "picked", "keep", "old"],
      dates: {
        main: NOW - 99 * DAY,
        picked: NOW - 99 * DAY,
        keep: NOW - 99 * DAY,
        old: NOW - 99 * DAY
      }
    });
    expect([...result.matched].toSorted()).toEqual(["keep", "main", "old", "picked"]);
    expect([...result.hidable]).toEqual(["old"]);
  });

  it("keeps branches whose age is unknown (no date entry)", () => {
    const result = classifyInactive({
      ...base,
      branches: ["main", "mystery"],
      dates: { main: NOW }
    });
    expect(result.matched.size).toBe(0);
  });

  it("disables classification when the threshold is 0 or negative", () => {
    const result = classifyInactive({
      ...base,
      thresholdDays: 0,
      branches: ["main", "ancient"],
      dates: { main: NOW, ancient: NOW - 9999 * DAY }
    });
    expect(result.matched.size).toBe(0);
    expect(result.hidable.size).toBe(0);
  });

  it("treats a branch exactly at the cutoff as still active", () => {
    const result = classifyInactive({
      ...base,
      branches: ["main", "edge"],
      dates: { main: NOW, edge: NOW - 30 * DAY }
    });
    expect(result.matched.has("edge")).toBe(false);
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
