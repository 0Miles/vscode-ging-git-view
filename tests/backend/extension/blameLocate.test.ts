import { describe, expect, it } from "vitest";

import { commitLocationArgs, filterMayHideCommit } from "@/extension/blameLocate";

const SHA = "a".repeat(40);
const KNOWN = ["/repo", "/repo/sub"];

describe("commitLocationArgs", () => {
  it("accepts a full commit hash in a known repository", () => {
    expect(commitLocationArgs({ repo: "/repo/sub", sha: SHA }, KNOWN)).toEqual({
      repo: "/repo/sub",
      sha: SHA
    });
    const sha256 = "c".repeat(64);
    expect(commitLocationArgs({ repo: "/repo", sha: sha256 }, KNOWN)).toEqual({
      repo: "/repo",
      sha: sha256
    });
  });

  it("refuses a repository that is not known (any more)", () => {
    expect(commitLocationArgs({ repo: "/elsewhere", sha: SHA }, KNOWN)).toBeNull();
  });

  it("refuses anything but a full commit hash", () => {
    for (const sha of [SHA.slice(0, 8), SHA.toUpperCase(), `${SHA}\n--all`, "HEAD", 42]) {
      expect(commitLocationArgs({ repo: "/repo", sha }, KNOWN)).toBeNull();
    }
  });

  it("refuses whatever else a command link could be handed", () => {
    expect(commitLocationArgs(undefined, KNOWN)).toBeNull();
    expect(commitLocationArgs(SHA, KNOWN)).toBeNull();
    expect(commitLocationArgs([{ repo: "/repo", sha: SHA }], KNOWN)).toBeNull();
    expect(commitLocationArgs({ sha: SHA }, KNOWN)).toBeNull();
  });
});

describe("filterMayHideCommit", () => {
  it("is false for an explicit show-all filter", () => {
    expect(filterMayHideCommit([])).toBe(false);
  });

  it("is true while branches are picked", () => {
    expect(filterMayHideCommit(["main"])).toBe(true);
  });

  it("is true for a repository with no filter recorded yet, whose first load would apply the configured default", () => {
    expect(filterMayHideCommit(undefined)).toBe(true);
  });
});
