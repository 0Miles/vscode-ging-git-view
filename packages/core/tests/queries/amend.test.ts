import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { amendBasis, remoteBranchesContainingHead } from "@ging/core/backend/queries/amend";

import { git, makeRepo, makeTempDir, rmrf } from "@ging/core/tests/helpers";

// What an amend of HEAD needs to know (#407): whether HEAD is already on a
// remote, and what it would start from. Real git, a bare repository for the
// remote.

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

function repo(): string {
  const dir = makeRepo();
  cleanUp.push(dir);
  return dir;
}

/** `repo` with a bare clone of it as `origin`, fetched, `origin/HEAD` set. */
function withOrigin(r: string): string {
  const bare = makeTempDir("ngg-test-bare-");
  cleanUp.push(bare);
  git(["clone", "-q", "--bare", r, bare], r);
  git(["remote", "add", "origin", bare], r);
  git(["fetch", "-q", "origin"], r);
  git(["remote", "set-head", "origin", "main"], r);
  return bare;
}

/** Run a git command expected to stop on a conflict, and so to fail. */
function stopsOnConflict(args: string[], cwd: string): void {
  expect(cp.spawnSync("git", args, { cwd }).status).not.toBe(0);
}

/** `main` and `feature` each changing shared.txt's one line. */
function diverged(): string {
  const r = repo();
  fs.writeFileSync(path.join(r, "shared.txt"), "base\n");
  git(["add", "."], r);
  git(["commit", "-m", "base"], r);
  git(["checkout", "-b", "feature"], r);
  fs.writeFileSync(path.join(r, "shared.txt"), "feature\n");
  git(["commit", "-am", "feature"], r);
  git(["checkout", "main"], r);
  fs.writeFileSync(path.join(r, "shared.txt"), "main\n");
  git(["commit", "-am", "main change"], r);
  return r;
}

describe("remoteBranchesContainingHead", () => {
  it("names the remote branches HEAD is on, from a clone of a bare repository", async () => {
    const r = repo();
    const bare = withOrigin(r);
    // A second branch on the remote, at the same commit.
    git(["--git-dir=" + bare, "branch", "release"], r);
    git(["fetch", "-q", "origin"], r);

    // origin/HEAD is a symbolic ref to origin/main: not listed twice.
    expect(await remoteBranchesContainingHead(simpleGit(r))).toEqual([
      "origin/main",
      "origin/release"
    ]);
  });

  it("names none once HEAD has moved on past them", async () => {
    const r = repo();
    withOrigin(r);
    git(["commit", "-q", "--allow-empty", "-m", "not pushed"], r);

    expect(await remoteBranchesContainingHead(simpleGit(r))).toEqual([]);
  });

  it("names none without a remote, or on a branch with no commit yet", async () => {
    expect(await remoteBranchesContainingHead(simpleGit(repo()))).toEqual([]);

    const unborn = makeTempDir("ngg-test-");
    cleanUp.push(unborn);
    git(["init", "-q", "--template=", "-b", "main"], unborn);
    expect(await remoteBranchesContainingHead(simpleGit(unborn))).toEqual([]);
  });
});

describe("amendBasis", () => {
  it("is HEAD's message as written", async () => {
    const r = repo();
    git(["commit", "-q", "--allow-empty", "-m", "Subject\n\nA body\nover two lines."], r);

    expect(await amendBasis(simpleGit(r))).toEqual({
      possible: true,
      message: "Subject\n\nA body\nover two lines."
    });
  });

  it("is refused on a branch with no commit yet", async () => {
    const r = makeTempDir("ngg-test-");
    cleanUp.push(r);
    git(["init", "-q", "--template=", "-b", "main"], r);

    expect(await amendBasis(simpleGit(r))).toEqual({ possible: false, reason: "unborn" });
  });

  it("is refused while a merge, a rebase or a cherry-pick has stopped on a conflict", async () => {
    const merging = diverged();
    stopsOnConflict(["merge", "feature"], merging);
    const rebasing = diverged();
    git(["checkout", "-q", "feature"], rebasing);
    stopsOnConflict(["rebase", "main"], rebasing);
    const picking = diverged();
    stopsOnConflict(["cherry-pick", "feature"], picking);

    expect(await amendBasis(simpleGit(merging))).toEqual({ possible: false, reason: "merge" });
    expect(await amendBasis(simpleGit(rebasing))).toEqual({ possible: false, reason: "rebase" });
    expect(await amendBasis(simpleGit(picking))).toEqual({
      possible: false,
      reason: "cherrypick"
    });
  });

  it("is refused while a revert has stopped on a conflict", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "r.txt"), "v1\n");
    git(["add", "."], r);
    git(["commit", "-m", "add r"], r);
    fs.writeFileSync(path.join(r, "r.txt"), "v2\n");
    git(["commit", "-am", "change r"], r);
    stopsOnConflict(["revert", "--no-edit", "HEAD~1"], r);

    expect(await amendBasis(simpleGit(r))).toEqual({ possible: false, reason: "revert" });
  });
});
