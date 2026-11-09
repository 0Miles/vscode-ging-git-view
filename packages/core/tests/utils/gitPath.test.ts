import { describe, expect, it } from "vitest";

import { resolveGitPath } from "@/backend/utils/gitPath";

const noneExist = () => false;
const allExist = () => true;

describe("resolveGitPath", () => {
  it("returns a single configured path unchanged", () => {
    expect(resolveGitPath("/usr/bin/git", allExist)).toBe("/usr/bin/git");
  });

  it("falls back to 'git' when unset", () => {
    expect(resolveGitPath(null, noneExist)).toBe("git");
    expect(resolveGitPath(undefined, noneExist)).toBe("git");
    expect(resolveGitPath("", noneExist)).toBe("git");
  });

  it("picks the first existing path from an array", () => {
    expect(
      resolveGitPath(
        ["/missing/git", "/opt/git/bin/git", "/other/git"],
        (p) => p === "/opt/git/bin/git"
      )
    ).toBe("/opt/git/bin/git");
  });

  it("falls back to the first candidate when none exist", () => {
    expect(resolveGitPath(["/a/git", "/b/git"], noneExist)).toBe("/a/git");
  });

  it("ignores empty entries in the array", () => {
    expect(resolveGitPath(["", "/a/git"], noneExist)).toBe("/a/git");
  });

  it("falls back to 'git' for an empty array", () => {
    expect(resolveGitPath([], noneExist)).toBe("git");
  });
});
