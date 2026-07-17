import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteBranch } from "@/backend/actions/branch";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
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
      fs.rmSync(localRepo, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });
});
