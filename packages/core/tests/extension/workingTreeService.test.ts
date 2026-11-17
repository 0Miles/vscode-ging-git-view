import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkingTreeService } from "@ging/core/extension/workingTreeService";

import { git, makeRepo, makeTempDir, rev, rmrf } from "@ging/core/tests/helpers";

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

function setUp(signCommits = false) {
  const repo = makeRepo();
  cleanUp.push(repo);
  /** What the host was asked to do, in order. */
  const calls: string[] = [];
  const service = createWorkingTreeService({
    git: () => simpleGit(repo),
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
      refused: { kind: "pushed", remoteBranches: ["origin/main"] }
    });
    expect(rev(repo, "HEAD")).toBe(before);
    // Declined, so no change was made of it: nothing muted, nothing refreshed.
    expect(calls).toEqual([]);

    const made = await service.commit({ message: "Reworded", amend: true, rewritePushed: true });
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
});
