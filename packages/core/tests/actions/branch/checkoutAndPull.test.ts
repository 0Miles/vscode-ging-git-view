import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, describe, expect, it } from "vitest";

import { checkoutAndPullBranch } from "@ging/core/backend/actions/branch";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmrf(dir);
});

function out(args: string[], cwd: string): string {
  return cp.execFileSync("git", args, { cwd }).toString().trim();
}

/** A repo whose `main` has diverged from `origin/main` — one commit only here,
 *  one only on the remote — and which sits on another branch, so the action
 *  has a checkout to do before it pulls. */
function divergedRepo(): string {
  const repo = makeRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-remote-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-other-"));
  dirs.push(repo, remote, other);
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], repo);
  git(["push", "-u", "origin", "main"], repo);

  cp.execFileSync("git", ["clone", remote, other]);
  git(
    [
      "-c",
      "user.email=o@o.com",
      "-c",
      "user.name=O",
      "commit",
      "--allow-empty",
      "-m",
      "upstream commit"
    ],
    other
  );
  git(["push", "origin", "main"], other);

  git(["commit", "--allow-empty", "-m", "local commit"], repo);
  git(["checkout", "-b", "side"], repo);
  return repo;
}

/**
 * Budget for each test: `divergedRepo` runs eleven git commands one after
 * another (the repository's three, a bare init, a push, a clone, two commits,
 * another push and a checkout), then the action's checkout, fetch and rebase
 * or merge.
 *
 * Measured with 16 busy loops pinning the CPU on Windows (#476): 18.0–23.7s
 * each, and over the backend's 30s default under the owner's heavier load.
 * About two and a half times the worst of those.
 */
const DIVERGED_PULL_TIMEOUT_MS = 60_000;

describe("checkoutAndPullBranch", () => {
  it(
    "checks the branch out and rebases local commits onto the remote under pull.rebase=true",
    { timeout: DIVERGED_PULL_TIMEOUT_MS },
    async () => {
      const repo = divergedRepo();
      git(["config", "pull.rebase", "true"], repo);

      await checkoutAndPullBranch(simpleGit(repo), {
        branchName: "main",
        remote: "origin",
        branchOnRemote: "main"
      });

      expect(out(["branch", "--show-current"], repo)).toBe("main");
      // Linear: the local commit now sits on top of the remote's, nothing lost.
      expect(out(["log", "--format=%s"], repo).split("\n")).toEqual([
        "local commit",
        "upstream commit",
        "init"
      ]);
      expect(out(["rev-parse", "main~1"], repo)).toBe(out(["rev-parse", "origin/main"], repo));
    }
  );

  it(
    "merges instead under pull.rebase=false, still keeping the local commit",
    { timeout: DIVERGED_PULL_TIMEOUT_MS },
    async () => {
      const repo = divergedRepo();
      git(["config", "pull.rebase", "false"], repo);

      await checkoutAndPullBranch(simpleGit(repo), {
        branchName: "main",
        remote: "origin",
        branchOnRemote: "main"
      });

      expect(out(["branch", "--show-current"], repo)).toBe("main");
      expect(out(["rev-list", "--merges", "--count", "main"], repo)).toBe("1");
      const subjects = out(["log", "--format=%s"], repo);
      expect(subjects).toContain("local commit");
      expect(subjects).toContain("upstream commit");
    }
  );

  it(
    "throws, leaving the branch checked out, when the remote does not exist",
    { timeout: DIVERGED_PULL_TIMEOUT_MS },
    async () => {
      const repo = divergedRepo();

      await expect(
        checkoutAndPullBranch(simpleGit(repo), {
          branchName: "main",
          remote: "no-such-remote",
          branchOnRemote: "main"
        })
      ).rejects.toThrow();
      expect(out(["branch", "--show-current"], repo)).toBe("main");
    }
  );
});
