import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchIntoLocalBranch } from "@/backend/actions/branch";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let remote: string;
let other: string;

beforeAll(() => {
  repo = makeRepo();
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "neo-remote-"));
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], repo);
  git(["push", "origin", "main"], repo);

  // A second clone pushes a `feature` branch to the remote.
  other = fs.mkdtempSync(path.join(os.tmpdir(), "neo-other-"));
  cp.execFileSync("git", ["clone", remote, other]);
  cp.execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: other });
  cp.execFileSync("git", ["config", "user.name", "Other"], { cwd: other });
  cp.execFileSync("git", ["checkout", "-b", "feature"], { cwd: other });
  fs.writeFileSync(path.join(other, "feature.txt"), "feature work");
  cp.execFileSync("git", ["add", "."], { cwd: other });
  cp.execFileSync("git", ["commit", "-m", "feature commit"], { cwd: other });
  cp.execFileSync("git", ["push", "origin", "feature"], { cwd: other });
});

afterAll(() => {
  for (const dir of [repo, remote, other]) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetchIntoLocalBranch", () => {
  it("creates a local branch from the remote branch", async () => {
    await fetchIntoLocalBranch(simpleGit(repo), {
      remote: "origin",
      remoteBranch: "feature",
      localBranch: "feature",
      force: false
    });

    const branches = cp.execFileSync("git", ["branch", "--list"], { cwd: repo }).toString();
    expect(branches).toContain("feature");
    const log = cp.execFileSync("git", ["log", "--oneline", "feature"], { cwd: repo }).toString();
    expect(log).toContain("feature commit");
  });

  it("throws when fetching into the currently checked-out branch", async () => {
    // git refuses to update the current branch via fetch refspec without --update-head-ok.
    await expect(
      fetchIntoLocalBranch(simpleGit(repo), {
        remote: "origin",
        remoteBranch: "feature",
        localBranch: "main",
        force: false
      })
    ).rejects.toThrow();
  });
});
