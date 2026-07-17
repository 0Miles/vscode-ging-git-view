import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { operationState } from "@/backend/queries/operationState";

import { git, makeRepo } from "@tests/backend/helpers";

// Run a git command that is expected to conflict (and so exit non-zero),
// leaving the operation in progress.
function gitExpectConflict(args: string[], cwd: string): void {
  try {
    cp.execFileSync("git", args, { cwd, stdio: "pipe" });
  } catch {
    /* expected: the command conflicted */
  }
}

let cleanRepo: string;
let mergeRepo: string;
let rebaseRepo: string;
let cherryPickRepo: string;
let revertRepo: string;

// A repo where `main` and `feature` both change shared.txt's only line, so any
// of merge/rebase/cherry-pick between them conflicts.
function makeDivergedRepo(): string {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(["add", "."], repo);
  git(["commit", "-m", "base"], repo);
  git(["checkout", "-b", "feature"], repo);
  fs.writeFileSync(path.join(repo, "shared.txt"), "feature\n");
  git(["commit", "-am", "feature"], repo);
  git(["checkout", "main"], repo);
  fs.writeFileSync(path.join(repo, "shared.txt"), "main\n");
  git(["commit", "-am", "main change"], repo);
  return repo;
}

beforeAll(() => {
  cleanRepo = makeRepo();

  mergeRepo = makeDivergedRepo();
  gitExpectConflict(["merge", "feature"], mergeRepo); // on main

  rebaseRepo = makeDivergedRepo();
  git(["checkout", "feature"], rebaseRepo);
  gitExpectConflict(["rebase", "main"], rebaseRepo);

  cherryPickRepo = makeDivergedRepo();
  gitExpectConflict(["cherry-pick", "feature"], cherryPickRepo); // on main

  // Revert: c1 adds the file, c2 modifies it; reverting c1 conflicts with c2.
  revertRepo = makeRepo();
  fs.writeFileSync(path.join(revertRepo, "r.txt"), "v1\n");
  git(["add", "."], revertRepo);
  git(["commit", "-m", "c1 add"], revertRepo);
  const c1 = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: revertRepo }).toString().trim();
  fs.writeFileSync(path.join(revertRepo, "r.txt"), "v2\n");
  git(["commit", "-am", "c2 modify"], revertRepo);
  gitExpectConflict(["revert", "--no-edit", c1], revertRepo);
});

afterAll(() => {
  for (const dir of [cleanRepo, mergeRepo, rebaseRepo, cherryPickRepo, revertRepo]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("operationState (real git)", () => {
  it("reports no operation in a clean repo", async () => {
    const s = await operationState(simpleGit(cleanRepo));
    expect(s.operation).toBeNull();
    expect(s.conflictedFiles).toEqual([]);
  });

  it("detects an in-progress merge and its conflicted files", async () => {
    const s = await operationState(simpleGit(mergeRepo));
    expect(s.operation).toBe("merge");
    expect(s.conflictedFiles).toContain("shared.txt");
  });

  it("detects an in-progress rebase", async () => {
    const s = await operationState(simpleGit(rebaseRepo));
    expect(s.operation).toBe("rebase");
    expect(s.conflictedFiles).toContain("shared.txt");
  });

  it("detects an in-progress cherry-pick", async () => {
    const s = await operationState(simpleGit(cherryPickRepo));
    expect(s.operation).toBe("cherrypick");
    expect(s.conflictedFiles).toContain("shared.txt");
  });

  it("detects an in-progress revert", async () => {
    const s = await operationState(simpleGit(revertRepo));
    expect(s.operation).toBe("revert");
    expect(s.conflictedFiles).toContain("r.txt");
  });
});
