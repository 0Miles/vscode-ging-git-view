import { describe, expect, it } from "vitest";

import { isWatchedRepoPath } from "@/backend/utils/repoWatchPaths";

describe("isWatchedRepoPath", () => {
  it("watches in-progress operation markers (so the conflict banner appears/clears)", () => {
    for (const p of [
      ".git/MERGE_HEAD",
      ".git/REVERT_HEAD",
      ".git/CHERRY_PICK_HEAD",
      ".git/REBASE_HEAD",
      ".git/rebase-merge/done",
      ".git/rebase-apply/0001"
    ]) {
      expect(isWatchedRepoPath(p)).toBe(true);
    }
  });

  it("still watches refs / HEAD / config / stash, working-tree files, and root .git* files", () => {
    for (const p of [
      ".git/HEAD",
      ".git/config",
      ".git/index",
      ".git/refs/heads/main",
      ".git/refs/remotes/origin/main",
      ".git/refs/stash",
      "src/foo.ts",
      ".gitignore"
    ]) {
      expect(isWatchedRepoPath(p)).toBe(true);
    }
  });

  it("ignores unrelated internal .git files", () => {
    expect(isWatchedRepoPath(".git/COMMIT_EDITMSG")).toBe(false);
    expect(isWatchedRepoPath(".git/logs/HEAD")).toBe(false);
  });
});
