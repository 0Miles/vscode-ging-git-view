import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { createWorkingTreeService } from "@ging/core/extension/workingTreeService";

import { makeRepo, rmrf } from "@ging/core/tests/helpers";

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
      error: null
    });
    expect(calls).toEqual([]);
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

    const committed = await service.commit("Change f");
    expect(committed).toEqual({
      status: {
        branch: "main",
        staged: [],
        unstaged: [{ path: "new", change: "untracked" }],
        conflicted: []
      },
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

    const answer = await service.commit("Nothing staged");

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
    const [, committed] = await Promise.all([service.stage(["f"]), service.commit("Both")]);

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
});
