import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { pushBranch, pushBranches } from "@/backend/actions/branch";
import type { ActionPayload } from "@/backend/types";
import { formatGitError, isRemoteUpdatedSinceCheckoutError } from "@/backend/utils/gitError";

import { bareGit, git, makeRepo, rmrf } from "@tests/backend/helpers";

// "Force with lease" means the remote tip has been *integrated* into the local
// branch, not merely fetched (ADR-0025). Each scenario builds its own repo,
// bare remote and teammate clone: push.test.ts shares one repo across its
// cases and rewrites `main` along the way, which these histories cannot sit on.

type World = { local: string; remote: string; teammate: string };

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmrf(dir);
  dirs = [];
});

/** A local repo whose `main` is pushed to a fresh bare remote, plus a second
 *  clone of that remote standing in for a teammate. */
function makeWorld(): World {
  const local = makeRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-lease-remote-"));
  const teammateParent = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-lease-teammate-"));
  dirs.push(local, remote, teammateParent);
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], local);
  git(["push", "-u", "origin", "main"], local);

  const teammate = path.join(teammateParent, "clone");
  git(["clone", remote, teammate], teammateParent);
  git(["config", "user.email", "mate@t.com"], teammate);
  git(["config", "user.name", "Mate"], teammate);
  git(["config", "commit.gpgsign", "false"], teammate);
  return { local, remote, teammate };
}

function commitFile(repo: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(repo, file), content);
  git(["add", "."], repo);
  git(["commit", "-m", message], repo);
}

/** Rewrite the local tip so the next push is no longer a fast-forward. */
function amendTip(repo: string, content: string) {
  fs.writeFileSync(path.join(repo, "mine.txt"), content);
  git(["add", "."], repo);
  git(["commit", "--amend", "-m", `amended: ${content}`], repo);
}

function rev(repo: string, ref: string): string {
  return cp.execFileSync("git", ["rev-parse", ref], { cwd: repo }).toString().trim();
}

function remoteMain(remote: string): string {
  return bareGit(["rev-parse", "main"], remote).trim();
}

/** A teammate pushes a commit the local repo has never seen. */
function teammatePushes({ teammate }: World) {
  commitFile(teammate, "mate.txt", "mate", "teammate's work");
  git(["push", "origin", "main"], teammate);
  return rev(teammate, "main");
}

async function pushMain(repo: string, forceMode: ActionPayload<"pushBranch">["forceMode"]) {
  await pushBranch(simpleGit(repo), { branchName: "main", remotes: ["origin"], forceMode });
}

async function rejection(push: Promise<void>): Promise<unknown> {
  try {
    await push;
  } catch (e: unknown) {
    return e;
  }
  throw new Error("expected the push to be rejected");
}

describe("pushBranch with force-with-lease", () => {
  it("refuses to overwrite a teammate's commit that was fetched but never integrated", async () => {
    const world = makeWorld();
    const matesTip = teammatePushes(world);
    // Background auto-fetch (or the graph's Fetch) moves the tracking ref, so
    // a bare lease would take the teammate's commit as the expected value.
    git(["fetch", "origin"], world.local);
    amendTip(world.local, "rewritten");

    const error = await rejection(pushMain(world.local, "forceWithLease"));

    expect(isRemoteUpdatedSinceCheckoutError(error)).toBe(true);
    // The line the webview shows beneath its explanation.
    expect(formatGitError(error)).toMatch(
      /^\[rejected\]\s+main -> main \(remote ref updated since checkout\)$/
    );
    expect(remoteMain(world.remote)).toBe(matesTip);
  });

  it("overwrites once the teammate's commit has been integrated by a rebase", async () => {
    const world = makeWorld();
    const matesTip = teammatePushes(world);
    commitFile(world.local, "mine.txt", "mine", "my work");
    git(["pull", "--rebase", "origin", "main"], world.local);
    // Rewrite on top of the integrated history, so the push still needs force.
    amendTip(world.local, "polished");

    await pushMain(world.local, "forceWithLease");

    expect(remoteMain(world.remote)).toBe(rev(world.local, "main"));
    expect(rev(world.local, "main~1")).toBe(matesTip);
  });

  it("overwrites an amend of one's own pushed commit when nobody else pushed", async () => {
    const world = makeWorld();
    amendTip(world.local, "fixup");

    await pushMain(world.local, "forceWithLease");

    expect(remoteMain(world.remote)).toBe(rev(world.local, "main"));
  });
});

describe("pushBranches with force-with-lease", () => {
  it("flags only the branch refused for an unintegrated remote tip", async () => {
    const world = makeWorld();
    // A second branch of the local repo's own, pushed and then rewritten: its
    // lease has nothing unintegrated to protect, so it goes through.
    git(["checkout", "-b", "side"], world.local);
    commitFile(world.local, "side.txt", "side", "side work");
    git(["push", "-u", "origin", "side"], world.local);
    amendTip(world.local, "side rewritten");
    git(["checkout", "main"], world.local);

    const matesTip = teammatePushes(world);
    git(["fetch", "origin"], world.local);
    amendTip(world.local, "rewritten");

    const results = await pushBranches(simpleGit(world.local), {
      branchNames: ["main", "side"],
      remotes: ["origin"],
      forceMode: "forceWithLease"
    });

    expect(results).toEqual([
      {
        ref: "main",
        // git's own line stays the ref's status; the explanation is the webview's.
        status: expect.stringMatching(
          /^\[rejected\]\s+main -> main \(remote ref updated since checkout\)$/
        ),
        remoteUpdatedSinceCheckout: true
      },
      { ref: "side", status: null, remoteUpdatedSinceCheckout: false }
    ]);
    expect(remoteMain(world.remote)).toBe(matesTip);
    expect(bareGit(["rev-parse", "side"], world.remote).trim()).toBe(rev(world.local, "side"));
  });
});

describe("pushBranch without a lease", () => {
  it("reports a rejected normal push as git's own readable line", async () => {
    const world = makeWorld();
    const matesTip = teammatePushes(world);
    git(["fetch", "origin"], world.local);
    amendTip(world.local, "rewritten");

    const error = await rejection(pushMain(world.local, "normal"));

    expect(formatGitError(error)).toMatch(/^\[rejected\]\s+main -> main \(non-fast-forward\)$/);
    expect(isRemoteUpdatedSinceCheckoutError(error)).toBe(false);
    expect(remoteMain(world.remote)).toBe(matesTip);
  });

  it("still overwrites unconditionally with force", async () => {
    const world = makeWorld();
    teammatePushes(world);
    git(["fetch", "origin"], world.local);
    amendTip(world.local, "rewritten");

    await pushMain(world.local, "force");

    expect(remoteMain(world.remote)).toBe(rev(world.local, "main"));
  });
});
