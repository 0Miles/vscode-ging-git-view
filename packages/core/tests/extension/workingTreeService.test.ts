import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkingTreeService } from "@ging/core/extension/workingTreeService";

import { makeRepo, rmrf } from "@ging/core/tests/helpers";

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
      error: null
    });
    expect(calls).toEqual([]);
  });

  it("stages, unstages and commits as repo mutations, each answered with the status after it", async () => {
    const { repo, calls, service } = setUp();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.writeFileSync(path.join(repo, "new"), "new");

    const staged = await service.stage(null);
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
});
