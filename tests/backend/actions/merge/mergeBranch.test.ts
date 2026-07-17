import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mergeBranch } from "@/backend/actions/merge";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
  git(["checkout", "-b", "feature"], repo);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature");
  git(["add", "."], repo);
  git(["commit", "-m", "feature commit"], repo);
  git(["checkout", "main"], repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("mergeBranch", () => {
  it("merges a branch with fast-forward by default", async () => {
    await mergeBranch(simpleGit(repo), {
      branchName: "feature",
      createNewCommit: false,
      squash: false,
      noCommit: false
    });

    const log = cp.execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString();
    expect(log).toContain("feature commit");
  });

  it("merges a branch with --no-ff when createNewCommit is true", async () => {
    git(["checkout", "-b", "feature2"], repo);
    fs.writeFileSync(path.join(repo, "feature2.txt"), "feature2");
    git(["add", "."], repo);
    git(["commit", "-m", "feature2 commit"], repo);
    git(["checkout", "main"], repo);

    await mergeBranch(simpleGit(repo), {
      branchName: "feature2",
      createNewCommit: true,
      squash: false,
      noCommit: false
    });

    const log = cp.execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString();
    expect(log).toContain("Merge branch");
  });

  it("squashes into a single non-merge commit when squash is true", async () => {
    git(["checkout", "-b", "feature3"], repo);
    fs.writeFileSync(path.join(repo, "feature3.txt"), "feature3");
    git(["add", "."], repo);
    git(["commit", "-m", "feature3 commit"], repo);
    git(["checkout", "main"], repo);

    await mergeBranch(simpleGit(repo), {
      branchName: "feature3",
      createNewCommit: false,
      squash: true,
      noCommit: false
    });

    // A squash merge results in an ordinary commit with a single parent,
    // not a two-parent merge commit.
    const parents = cp
      .execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: repo })
      .toString()
      .trim()
      .split(" ");
    expect(parents).toHaveLength(2); // <commit> <single-parent>
    const log = cp.execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString();
    expect(log).toContain("Merge branch 'feature3'");
    expect(fs.existsSync(path.join(repo, "feature3.txt"))).toBe(true);
  });

  it("uses git's detailed SQUASH_MSG when that format is selected", async () => {
    git(["checkout", "-b", "feature4"], repo);
    fs.writeFileSync(path.join(repo, "feature4.txt"), "feature4");
    git(["add", "."], repo);
    git(["commit", "-m", "feature4 squashed commit subject"], repo);
    git(["checkout", "main"], repo);

    await mergeBranch(
      simpleGit(repo),
      { branchName: "feature4", createNewCommit: false, squash: true, noCommit: false },
      "Git SQUASH_MSG"
    );

    const message = cp.execFileSync("git", ["log", "-1", "--format=%B"], { cwd: repo }).toString();
    // Git's SQUASH_MSG lists the squashed commits, rather than "Merge branch ...".
    expect(message).toContain("Squashed commit of the following");
    expect(message).toContain("feature4 squashed commit subject");
    expect(message).not.toContain("Merge branch 'feature4'");
  });

  it("does not commit pre-staged changes on an up-to-date squash merge", async () => {
    // `feature` was fast-forward merged earlier, so it is an ancestor of HEAD
    // and re-merging it is a no-op ("Already up to date"). Stage an unrelated
    // change; it must NOT be swept into a merge commit.
    const headBefore = cp
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "wip");
    git(["add", "unrelated.txt"], repo);

    await mergeBranch(simpleGit(repo), {
      branchName: "feature",
      createNewCommit: false,
      squash: true,
      noCommit: false
    });

    const headAfter = cp
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    expect(headAfter).toBe(headBefore); // no commit was created
    const staged = cp
      .execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo })
      .toString();
    expect(staged).toContain("unrelated.txt"); // still staged, untouched

    git(["reset", "--hard", "HEAD"], repo); // clean up for any later tests
  });

  it("stages the merge without committing when noCommit is true", async () => {
    git(["checkout", "-b", "ncfeature"], repo);
    fs.writeFileSync(path.join(repo, "nc.txt"), "nc");
    git(["add", "."], repo);
    git(["commit", "-m", "nc feature commit"], repo);
    git(["checkout", "main"], repo);
    fs.writeFileSync(path.join(repo, "nc-main.txt"), "nc-main");
    git(["add", "."], repo);
    git(["commit", "-m", "nc main commit"], repo); // diverge so the merge isn't a fast-forward

    const headBefore = cp
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    await mergeBranch(simpleGit(repo), {
      branchName: "ncfeature",
      createNewCommit: true,
      squash: false,
      noCommit: true
    });

    const headAfter = cp
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    expect(headAfter).toBe(headBefore); // merge not committed yet
    const gitDir = cp
      .execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: repo })
      .toString()
      .trim();
    expect(fs.existsSync(path.join(gitDir, "MERGE_HEAD"))).toBe(true); // merge in progress

    git(["merge", "--abort"], repo); // clean up for later tests
  });

  it("throws when the branch does not exist", async () => {
    await expect(
      mergeBranch(simpleGit(repo), {
        branchName: "nonexistent-branch",
        createNewCommit: false,
        squash: false,
        noCommit: false
      })
    ).rejects.toThrow();
  });
});
