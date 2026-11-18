import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { createWorkingTreeService } from "@ging/core/extension/workingTreeService";

import { git, makeRepo, makeTempDir, rev, rmrf } from "@ging/core/tests/helpers";

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

function setUp(signCommits = false) {
  const repo = makeRepo();
  cleanUp.push(repo);
  const client = gitClientFactory(repo, "git");
  /** What the host was asked to do, in order. */
  const calls: string[] = [];
  const service = createWorkingTreeService({
    // A client as the host makes one: its no-op editor is what lets
    // `merge --continue` finish instead of waiting on one (gitSpawn.ts).
    git: () => client.getInstance(),
    diffRun: () => ({ gitPath: "git", repoPath: repo }),
    repo: () => repo,
    signCommits: () => signCommits,
    runRepoMutation: async (on, work) => {
      calls.push(`mute ${on === repo ? "repo" : on}`);
      try {
        await work();
      } finally {
        calls.push("refresh");
      }
    }
  });
  return { repo, calls, service };
}

describe("the working tree service", () => {
  it("reads the status without making a change of it", async () => {
    const { repo, calls, service } = setUp();
    fs.writeFileSync(path.join(repo, "f"), "changed");

    expect(await service.status()).toEqual({
      status: {
        branch: "main",
        staged: [],
        unstaged: [{ path: "f", change: "modified" }],
        conflicted: []
      },
      amend: { possible: true, message: "init" },
      error: null
    });
    expect(calls).toEqual([]);
  });

  it("answers what an amend would start from, or why there can be none", async () => {
    const { repo, service } = setUp();
    fs.writeFileSync(path.join(repo, "f"), "on main");
    git(["commit", "-qam", "on main"], repo);
    git(["checkout", "-q", "-b", "side", "HEAD~1"], repo);
    fs.writeFileSync(path.join(repo, "f"), "on side");
    git(["commit", "-qam", "on side"], repo);
    expect((await service.status()).amend).toEqual({ possible: true, message: "on side" });

    expect(cp.spawnSync("git", ["merge", "main"], { cwd: repo }).status).not.toBe(0);

    expect((await service.status()).amend).toEqual({ possible: false, reason: "merge" });
  });

  it("answers an amend of a pushed HEAD with the branches it is on, and makes it only when told to", async () => {
    const { repo, calls, service } = setUp();
    const bare = makeTempDir("ngg-test-bare-");
    cleanUp.push(bare);
    git(["clone", "-q", "--bare", repo, bare], repo);
    git(["remote", "add", "origin", bare], repo);
    git(["fetch", "-q", "origin"], repo);
    const before = rev(repo, "HEAD");

    const refused = await service.commit({ message: "Reworded", amend: true });
    expect(refused).toEqual({
      status: expect.objectContaining({ staged: [] }),
      amend: { possible: true, message: "init" },
      error: null,
      refused: { kind: "pushed", head: before, remoteBranches: ["origin/main"] }
    });
    expect(rev(repo, "HEAD")).toBe(before);
    // Declined, so no change was made of it: nothing muted, nothing refreshed.
    expect(calls).toEqual([]);

    const made = await service.commit({
      message: "Reworded",
      amend: true,
      rewritePushed: before
    });
    expect(made.error).toBeNull();
    expect(made.refused).toBeUndefined();
    expect(made.amend).toEqual({ possible: true, message: "Reworded" });
    expect(calls).toEqual(["mute repo", "refresh"]);
  });

  it("stages, unstages and commits as repo mutations, each answered with the status after it", async () => {
    const { repo, calls, service } = setUp();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.writeFileSync(path.join(repo, "new"), "new");

    const staged = await service.stage(["f", "new"]);
    expect(staged.status?.staged.map((file) => file.path)).toEqual(["f", "new"]);

    const unstaged = await service.unstage(["new"]);
    expect(unstaged.status?.staged).toEqual([{ path: "f", change: "modified" }]);
    expect(unstaged.status?.unstaged).toEqual([{ path: "new", change: "untracked" }]);

    const committed = await service.commit({ message: "Change f" });
    expect(committed).toEqual({
      status: {
        branch: "main",
        staged: [],
        unstaged: [{ path: "new", change: "untracked" }],
        conflicted: []
      },
      amend: { possible: true, message: "Change f" },
      error: null
    });
    expect((await simpleGit(repo).raw(["log", "-1", "--format=%s"])).trim()).toBe("Change f");
    // Each change muted the watcher and refreshed the graph after it, so the
    // new commit shows there.
    expect(calls).toEqual(["mute repo", "refresh", "mute repo", "refresh", "mute repo", "refresh"]);
  });

  it("answers a failure with why, and the status as it still is", async () => {
    const { repo, calls, service } = setUp();
    fs.writeFileSync(path.join(repo, "f"), "not staged");

    const answer = await service.commit({ message: "Nothing staged" });

    expect(answer.error).toEqual(expect.any(String));
    expect(answer.error).not.toBe("");
    expect(answer.status?.unstaged).toEqual([{ path: "f", change: "modified" }]);
    // Refreshed even so: a failed change may have changed something.
    expect(calls).toEqual(["mute repo", "refresh"]);
  });

  it("runs its calls one at a time, in the order made", async () => {
    const { repo, service } = setUp();
    fs.writeFileSync(path.join(repo, "f"), "changed");

    // Not awaited in between: the commit must see the stage done.
    const [, committed] = await Promise.all([
      service.stage(["f"]),
      service.commit({ message: "Both" })
    ]);

    expect(committed.error).toBeNull();
    expect(committed.status?.staged).toEqual([]);
    expect(committed.status?.unstaged).toEqual([]);
  });

  describe("in a merge stopped on a conflict (#410)", () => {
    function conflicted() {
      const set = setUp();
      const { repo } = set;
      const run = (...args: string[]) => cp.execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      run("checkout", "-q", "-b", "side");
      fs.writeFileSync(path.join(repo, "f"), "side");
      run("commit", "-qam", "side");
      run("checkout", "-q", "main");
      fs.writeFileSync(path.join(repo, "f"), "main");
      run("commit", "-qam", "main");
      expect(cp.spawnSync("git", ["merge", "side"], { cwd: repo }).status).not.toBe(0);
      return set;
    }
    const mergeHead = (repo: string) => fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"));

    it("names the merge in the status, with its conflict", async () => {
      const { service } = conflicted();

      const { status } = await service.status();

      expect(status?.operation).toBe("merge");
      expect(status?.conflicted).toEqual([{ path: "f", change: "conflicted" }]);
    });

    it("marks a file resolved, then continues the merge, each a repo mutation", async () => {
      const { repo, calls, service } = conflicted();
      fs.writeFileSync(path.join(repo, "f"), "both");

      const resolved = await service.resolve(["f"]);
      expect(resolved.error).toBeNull();
      expect(resolved.status?.conflicted).toEqual([]);
      expect(resolved.status?.staged).toEqual([{ path: "f", change: "modified" }]);
      expect(resolved.status?.operation).toBe("merge");

      const continued = await service.continueOperation();
      expect(continued.error).toBeNull();
      expect(continued.status?.operation).toBeUndefined();
      expect(mergeHead(repo)).toBe(false);
      const parents = (await simpleGit(repo).raw(["log", "-1", "--format=%P"])).trim().split(" ");
      expect(parents).toHaveLength(2);
      expect(calls).toEqual(["mute repo", "refresh", "mute repo", "refresh"]);
    });

    it("refuses to continue while a conflict is left, and aborts back to before the merge", async () => {
      const { repo, service } = conflicted();
      const before = (await simpleGit(repo).raw(["rev-parse", "HEAD"])).trim();

      const refused = await service.continueOperation();
      expect(refused.error).toMatch(/f/);
      expect(refused.status?.operation).toBe("merge");

      const aborted = await service.abortOperation();
      expect(aborted.error).toBeNull();
      expect(aborted.status).toEqual({ branch: "main", staged: [], unstaged: [], conflicted: [] });
      expect((await simpleGit(repo).raw(["rev-parse", "HEAD"])).trim()).toBe(before);
    });
  });

  describe("one hunk at a time (#406)", () => {
    const numbered = (change: (n: number) => string = String) =>
      Array.from({ length: 20 }, (_, i) => change(i + 1)).join("\n") + "\n";

    function twoHunks() {
      const set = setUp();
      fs.writeFileSync(path.join(set.repo, "f"), numbered());
      git(["commit", "-qam", "numbered"], set.repo);
      fs.writeFileSync(
        path.join(set.repo, "f"),
        numbered((n) => (n === 2 ? "two" : n === 19 ? "nineteen" : String(n)))
      );
      return set;
    }

    it("stages a hunk as a change of the repository: muted, then refreshed", async () => {
      const { repo, calls, service } = twoHunks();
      const hunks = await service.hunks("f", "unstaged");
      if (hunks.kind !== "hunks") throw new Error("no hunks");
      expect(hunks.hunks).toHaveLength(2);
      expect(calls).toEqual([]);

      const outcome = await service.applyHunk({
        path: "f",
        area: "unstaged",
        token: hunks.token,
        hunk: 1
      });

      expect(outcome).toEqual({ kind: "applied" });
      expect(calls).toEqual(["mute repo", "refresh"]);
      expect(cp.execFileSync("git", ["show", ":0:f"], { cwd: repo }).toString()).toBe(
        numbered((n) => (n === 19 ? "nineteen" : String(n)))
      );
    });

    it("answers a stale hunk as such, and makes no change of it", async () => {
      const { repo, calls, service } = twoHunks();
      const hunks = await service.hunks("f", "unstaged");
      if (hunks.kind !== "hunks") throw new Error("no hunks");
      fs.writeFileSync(path.join(repo, "f"), "zero\n" + numbered((n) => (n === 2 ? "two" : String(n))));

      const outcome = await service.applyHunk({
        path: "f",
        area: "unstaged",
        token: hunks.token,
        hunk: 0
      });

      expect(outcome).toEqual({ kind: "stale" });
      expect(calls).toEqual([]);
    });

    it("answers a file with no hunk of its own as such", async () => {
      const { repo, calls, service } = setUp();
      fs.writeFileSync(path.join(repo, "new"), "new\n");
      git(["add", "new"], repo);

      expect(await service.hunks("new", "staged")).toEqual({ kind: "none", reason: "added" });
      const outcome = await service.applyHunk({ path: "new", area: "staged", token: "x", hunk: 0 });
      expect(outcome).toEqual({ kind: "none", reason: "added" });
      expect(calls).toEqual([]);
    });

    it("answers HEAD's commit, or none on a branch without one", async () => {
      const { repo, service } = setUp();
      expect(await service.head()).toBe(rev(repo, "HEAD"));
      git(["checkout", "-q", "--orphan", "fresh"], repo);
      expect(await service.head()).toBeNull();
    });
  });
});
