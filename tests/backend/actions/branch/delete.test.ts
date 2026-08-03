import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteBranch } from "@/backend/actions/branch";
import { formatGitError, isNotFullyMergedError } from "@/backend/utils/gitError";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
});

afterAll(() => {
  rmrf(repo);
});

describe("deleteBranch", () => {
  it("deletes an existing branch", async () => {
    git(["branch", "to-delete"], repo);

    await deleteBranch(simpleGit(repo), {
      branchName: "to-delete",
      forceDelete: false,
      deleteOnRemotes: false
    });

    const listed = cp
      .execFileSync("git", ["branch", "--list", "to-delete"], { cwd: repo })
      .toString()
      .trim();
    expect(listed).toBe("");
  });

  it("throws when deleting a branch with unmerged changes without force", async () => {
    git(["checkout", "-b", "unmerged"], repo);
    fs.writeFileSync(path.join(repo, "g"), "y");
    git(["add", "."], repo);
    git(["commit", "-m", "unmerged commit"], repo);
    git(["checkout", "main"], repo);

    await expect(
      deleteBranch(simpleGit(repo), {
        branchName: "unmerged",
        forceDelete: false,
        deleteOnRemotes: false
      })
    ).rejects.toThrow();
  });

  // Regression: the force-delete offer used to be decided in the webview from
  // the formatted `status`, looking for git's `git branch -D` hint — which
  // `formatGitError` had already dropped, so the offer never appeared. Drive
  // the real deletion and the real formatter here rather than a hand-written
  // error string: the two have to stay consistent about which line the marker
  // lives on, and only git can say what that output actually is.
  it("refuses an unmerged branch with a marker that only survives on the raw error", async () => {
    git(["checkout", "-b", "unmerged-classified"], repo);
    fs.writeFileSync(path.join(repo, "h"), "z");
    git(["add", "."], repo);
    git(["commit", "-m", "another unmerged commit"], repo);
    git(["checkout", "main"], repo);

    let error: unknown = null;
    try {
      await deleteBranch(simpleGit(repo), {
        branchName: "unmerged-classified",
        forceDelete: false,
        deleteOnRemotes: false
      });
    } catch (e: unknown) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(isNotFullyMergedError(error)).toBe(true);
    // The formatted status the webview receives no longer carries the marker,
    // so classifying it there cannot work — hence the host-side flag.
    expect(formatGitError(error)).not.toContain("git branch -D");
    // Unrelated failures must not be mistaken for this case.
    expect(isNotFullyMergedError(new Error("error: some unrelated failure"))).toBe(false);
  });

  it("force-deletes a branch with unmerged changes", async () => {
    await deleteBranch(simpleGit(repo), {
      branchName: "unmerged",
      forceDelete: true,
      deleteOnRemotes: false
    });

    const listed = cp
      .execFileSync("git", ["branch", "--list", "unmerged"], { cwd: repo })
      .toString()
      .trim();
    expect(listed).toBe("");
  });

  it("throws when the branch does not exist", async () => {
    await expect(
      deleteBranch(simpleGit(repo), {
        branchName: "nonexistent",
        forceDelete: false,
        deleteOnRemotes: false
      })
    ).rejects.toThrow();
  });

  it("also deletes the branch on the remote when deleteOnRemotes is set", async () => {
    const localRepo = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "neo-remote-"));
    cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
    try {
      git(["remote", "add", "origin", remote], localRepo);
      git(["push", "origin", "main"], localRepo);
      git(["branch", "feature", "main"], localRepo);
      git(["push", "origin", "feature"], localRepo);

      // Sanity check: the branch exists on the remote before deletion.
      const before = cp
        .execFileSync("git", ["ls-remote", "--heads", "origin", "feature"], { cwd: localRepo })
        .toString()
        .trim();
      expect(before).not.toBe("");

      await deleteBranch(simpleGit(localRepo), {
        branchName: "feature",
        forceDelete: false,
        deleteOnRemotes: true
      });

      const localList = cp
        .execFileSync("git", ["branch", "--list", "feature"], { cwd: localRepo })
        .toString()
        .trim();
      expect(localList).toBe("");
      const after = cp
        .execFileSync("git", ["ls-remote", "--heads", "origin", "feature"], { cwd: localRepo })
        .toString()
        .trim();
      expect(after).toBe("");
    } finally {
      rmrf(localRepo);
      rmrf(remote);
    }
  });
});
