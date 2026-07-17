import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rebaseOn } from "@/backend/actions/rebase";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
  // feature branch adds a commit, main diverges with its own commit.
  git(["checkout", "-b", "feature"], repo);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature");
  git(["add", "."], repo);
  git(["commit", "-m", "feature commit"], repo);
  git(["checkout", "main"], repo);
  fs.writeFileSync(path.join(repo, "main.txt"), "main");
  git(["add", "."], repo);
  git(["commit", "-m", "main commit"], repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("rebaseOn", () => {
  it("rebases the current branch onto a branch", async () => {
    await rebaseOn(simpleGit(repo), { obj: "feature" });

    // After rebasing main onto feature, the feature commit is now an ancestor
    // of HEAD and the working tree contains both files.
    const log = cp.execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString();
    expect(log).toContain("feature commit");
    expect(log).toContain("main commit");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "main.txt"))).toBe(true);
  });

  it("throws when the target does not exist", async () => {
    await expect(rebaseOn(simpleGit(repo), { obj: "nonexistent-ref" })).rejects.toThrow();
  });
});
