import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBranch } from "@/backend/actions/branch";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let commitHash: string;

beforeAll(() => {
  repo = makeRepo();
  commitHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("createBranch", () => {
  it("creates a new branch at the given commit", async () => {
    await createBranch(simpleGit(repo), {
      branchName: "new-branch",
      commitHash,
      checkout: false,
      force: false
    });

    const listed = cp
      .execFileSync("git", ["branch", "--list", "new-branch"], { cwd: repo })
      .toString()
      .trim();
    expect(listed).toBe("new-branch");
    // Without checkout, HEAD stays on the original branch.
    const current = cp
      .execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    expect(current).not.toBe("new-branch");
  });

  it("checks out the new branch when checkout is true", async () => {
    await createBranch(simpleGit(repo), {
      branchName: "checked-out-branch",
      commitHash,
      checkout: true,
      force: false
    });

    const current = cp
      .execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    expect(current).toBe("checked-out-branch");

    // Restore HEAD so later tests don't depend on this one's side effect.
    cp.execFileSync("git", ["checkout", "main"], { cwd: repo });
  });

  it("throws when the branch already exists", async () => {
    await expect(
      createBranch(simpleGit(repo), {
        branchName: "main",
        commitHash,
        checkout: false,
        force: false
      })
    ).rejects.toThrow();
  });

  it("throws when the commit hash is invalid", async () => {
    await expect(
      createBranch(simpleGit(repo), {
        branchName: "bad-branch",
        commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        checkout: false,
        force: false
      })
    ).rejects.toThrow();
  });

  it("replaces an existing branch when force is set", async () => {
    // Point an existing branch at the initial commit, then force-create it at a
    // newer commit and confirm it moved.
    git(["branch", "-f", "movable", commitHash], repo);
    fs.writeFileSync(path.join(repo, "newer"), "x");
    git(["add", "."], repo);
    git(["commit", "-m", "newer commit"], repo);
    const newer = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    await createBranch(simpleGit(repo), {
      branchName: "movable",
      commitHash: newer,
      checkout: false,
      force: true
    });

    const resolved = cp
      .execFileSync("git", ["rev-parse", "movable"], { cwd: repo })
      .toString()
      .trim();
    expect(resolved).toBe(newer);
  });
});
