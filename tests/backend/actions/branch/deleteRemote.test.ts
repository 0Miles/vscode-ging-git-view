import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteRemoteBranch } from "@/backend/actions/branch";

import { git, makeRepo } from "@tests/backend/helpers";

let localRepo: string;
let remote: string;

beforeEach(() => {
  localRepo = makeRepo();
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-remote-"));
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], localRepo);
  git(["push", "origin", "main"], localRepo);
  git(["branch", "feature", "main"], localRepo);
  git(["push", "origin", "feature"], localRepo);
});

afterEach(() => {
  fs.rmSync(localRepo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

describe("deleteRemoteBranch", () => {
  it("deletes a branch that still exists on the remote", async () => {
    await deleteRemoteBranch(simpleGit(localRepo), { remote: "origin", branchName: "feature" });

    const onRemote = cp
      .execFileSync("git", ["ls-remote", "--heads", "origin", "feature"], { cwd: localRepo })
      .toString()
      .trim();
    expect(onRemote).toBe("");
  });

  it("prunes the stale local tracking ref when the branch is already gone on the remote", async () => {
    // Simulate the branch being deleted elsewhere: drop it directly on the bare
    // remote, leaving the local `refs/remotes/origin/feature` ref stale (a
    // `push --delete` would now report "remote ref does not exist"). Use an
    // explicit --git-dir so it works under `safe.bareRepository = explicit`.
    cp.execFileSync("git", [`--git-dir=${remote}`, "update-ref", "-d", "refs/heads/feature"]);

    // Sanity: the stale tracking ref still lingers locally before we act.
    expect(() =>
      cp.execFileSync("git", ["show-ref", "--verify", "refs/remotes/origin/feature"], {
        cwd: localRepo,
        stdio: "pipe"
      })
    ).not.toThrow();

    await expect(
      deleteRemoteBranch(simpleGit(localRepo), { remote: "origin", branchName: "feature" })
    ).resolves.toBeUndefined();

    // The stale tracking ref must be gone, so the label disappears from the graph.
    expect(() =>
      cp.execFileSync("git", ["show-ref", "--verify", "refs/remotes/origin/feature"], {
        cwd: localRepo,
        stdio: "pipe"
      })
    ).toThrow();
  });

  it("still throws on genuine failures (unknown remote)", async () => {
    await expect(
      deleteRemoteBranch(simpleGit(localRepo), { remote: "nonexistent", branchName: "feature" })
    ).rejects.toThrow();
  });
});
