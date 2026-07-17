import * as fs from "node:fs";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadStatistics, parseStatistics } from "@/backend/queries/loadStatistics";

import { makeRepo } from "@tests/backend/helpers";

describe("parseStatistics", () => {
  it("counts commits per author and bins by the author's local time", () => {
    const lines = [
      "Alice\x002020-01-01T10:00:00+05:00",
      // Same local clock time, different UTC offset — must land in the same bin
      // (proves we read the local fields, not a tz-converted time).
      "Alice\x002020-01-01T10:00:00-08:00",
      "Bob\x002020-01-02T23:00:00+00:00"
    ].join("\n");

    const s = parseStatistics(lines);
    expect(s.total).toBe(3);
    expect(s.byAuthor[0].name).toBe("Alice");
    expect(s.byAuthor[0].count).toBe(2);
    expect(s.byAuthor[0].percent).toBeCloseTo(66.667, 1);
    expect(s.byAuthor[1]).toEqual({ name: "Bob", count: 1, percent: expect.closeTo(33.333, 1) });

    // 2020-01-01 is a Wednesday (getUTCDay 3); both Alice commits at local 10:00.
    expect(s.heatmap[3][10]).toBe(2);
    // 2020-01-02 is a Thursday (4); Bob at local 23:00.
    expect(s.heatmap[4][23]).toBe(1);
  });

  it("bins regardless of the UTC offset spelling (+00:00 or Z)", () => {
    const lines = ["Z\x002021-03-04T08:00:00+00:00", "Z\x002021-03-04T08:00:00Z"].join("\n");
    const s = parseStatistics(lines);
    // 2021-03-04 is a Thursday (getUTCDay 4); both at local 08:00.
    expect(s.heatmap[4][8]).toBe(2);
  });

  it("skips anonymous (empty-name) commits", () => {
    const s = parseStatistics("\x002020-01-01T10:00:00+00:00\nReal\x002020-01-01T11:00:00+00:00");
    expect(s.total).toBe(1);
    expect(s.byAuthor).toEqual([{ name: "Real", count: 1, percent: 100 }]);
  });

  it("handles empty input", () => {
    const s = parseStatistics("");
    expect(s.total).toBe(0);
    expect(s.byAuthor).toEqual([]);
    expect(s.heatmap.flat().every((c) => c === 0)).toBe(true);
  });
});

describe("loadStatistics (real git)", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("summarizes a real repo's commits", async () => {
    const s = await loadStatistics(simpleGit(repo));
    expect(s.total).toBeGreaterThan(0);
    expect(s.byAuthor.some((a) => a.name === "T")).toBe(true);
    expect(s.capped).toBe(false);
  });
});
