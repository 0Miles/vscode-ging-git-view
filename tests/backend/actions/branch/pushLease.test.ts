import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  pushBranch,
  pushBranches,
  pushRefusalFacts,
  staleLeaseInfoRefs
} from "@/backend/actions/branch";
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

/** A second bare remote, `backup`, carrying the local `main`, with a current
 *  tracking ref for it. */
function addBackup(world: World): string {
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-lease-backup-"));
  dirs.push(backup);
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: backup });
  git(["remote", "add", "backup", backup], world.local);
  git(["push", "backup", "main"], world.local);
  return backup;
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

  // Before the integration check, a bare lease needs a tracking ref that still
  // matches the remote. Without one git refuses with "(stale info)" and names
  // only the remote's URL, so the error carries the tracking ref it lacked.

  it("names the tracking ref when the remote has the branch but there is none", async () => {
    const world = makeWorld();
    const matesTip = teammatePushes(world);
    git(["update-ref", "-d", "refs/remotes/origin/main"], world.local);
    amendTip(world.local, "rewritten");

    const error = await rejection(pushMain(world.local, "forceWithLease"));

    expect(staleLeaseInfoRefs(error)).toEqual(["origin/main"]);
    expect(isRemoteUpdatedSinceCheckoutError(error)).toBe(false);
    expect(formatGitError(error)).toMatch(/^\[rejected\]\s+main -> main \(stale info\)$/);
    expect(remoteMain(world.remote)).toBe(matesTip);
  });

  it("names the tracking ref when it is behind the remote and was never fetched", async () => {
    const world = makeWorld();
    const matesTip = teammatePushes(world);
    amendTip(world.local, "rewritten");

    const error = await rejection(pushMain(world.local, "forceWithLease"));

    expect(staleLeaseInfoRefs(error)).toEqual(["origin/main"]);
    expect(isRemoteUpdatedSinceCheckoutError(error)).toBe(false);
    expect(remoteMain(world.remote)).toBe(matesTip);
  });

  it("names the remote that refused, not every remote pushed to", async () => {
    const world = makeWorld();
    // A second remote whose tracking ref is current, so its lease holds.
    const backup = addBackup(world);
    teammatePushes(world);
    amendTip(world.local, "rewritten");

    const error = await rejection(
      pushBranch(simpleGit(world.local), {
        branchName: "main",
        remotes: ["origin", "backup"],
        forceMode: "forceWithLease"
      })
    );

    // Not "backup/main", whose push went through.
    expect(staleLeaseInfoRefs(error)).toEqual(["origin/main"]);
    // A lone refusal reads as it does with one remote: git's line, unlabelled.
    expect(formatGitError(error)).toMatch(/^\[rejected\]\s+main -> main \(stale info\)$/);
    // Listed after the remote that refused, and still pushed by the time the
    // refusal is reported: the answer waits for every remote (#264).
    expect(bareGit(["rev-parse", "main"], backup).trim()).toBe(rev(world.local, "main"));
  });

  it("names no tracking ref for any other refusal", async () => {
    const world = makeWorld();
    teammatePushes(world);
    git(["fetch", "origin"], world.local);
    amendTip(world.local, "rewritten");

    const error = await rejection(pushMain(world.local, "forceWithLease"));

    expect(staleLeaseInfoRefs(error)).toEqual([]);
  });
});

// Each remote refuses or accepts on its own. Stopping at the first refusal
// named one remote, explained one reason, and answered while the others were
// still pushing (#264).
describe("pushBranch with force-with-lease to several remotes", () => {
  /** The teammate's `main` pushed to `backup` as well, which the local repo
   *  has not fetched: its tracking ref there goes stale too. */
  function teammatePushesTo(world: World, backup: string) {
    git(["push", backup, "main"], world.teammate);
  }

  async function pushToBoth(world: World) {
    await pushBranch(simpleGit(world.local), {
      branchName: "main",
      remotes: ["origin", "backup"],
      forceMode: "forceWithLease"
    });
  }

  it("reports every remote that refused, each under its own name and reason", async () => {
    const world = makeWorld();
    const backup = addBackup(world);
    const matesTip = teammatePushes(world);
    teammatePushesTo(world, backup);
    // origin's tip is fetched but not integrated; backup's was never fetched.
    git(["fetch", "origin"], world.local);
    amendTip(world.local, "rewritten");

    const error = await rejection(pushToBoth(world));

    expect(formatGitError(error).split("\n")).toEqual([
      expect.stringMatching(
        /^origin: \[rejected\]\s+main -> main \(remote ref updated since checkout\)$/
      ),
      expect.stringMatching(/^backup: \[rejected\]\s+main -> main \(stale info\)$/)
    ]);
    // Both classifications survive, each read off its own remote's refusal.
    expect(pushRefusalFacts(error)).toEqual({
      remoteUpdatedSinceCheckout: true,
      staleInfoRefs: ["backup/main"]
    });
    expect(remoteMain(world.remote)).toBe(matesTip);
    expect(bareGit(["rev-parse", "main"], backup).trim()).toBe(matesTip);
  });

  it("names every tracking ref refused for stale info", async () => {
    const world = makeWorld();
    const backup = addBackup(world);
    teammatePushes(world);
    teammatePushesTo(world, backup);
    amendTip(world.local, "rewritten");

    const error = await rejection(pushToBoth(world));

    expect(pushRefusalFacts(error)).toEqual({
      remoteUpdatedSinceCheckout: false,
      staleInfoRefs: ["origin/main", "backup/main"]
    });
  });

  it("reports both refusals for each ref of a batch push", async () => {
    const world = makeWorld();
    const backup = addBackup(world);
    teammatePushes(world);
    teammatePushesTo(world, backup);
    amendTip(world.local, "rewritten");

    const results = await pushBranches(simpleGit(world.local), {
      branchNames: ["main"],
      remotes: ["origin", "backup"],
      forceMode: "forceWithLease"
    });

    expect(results).toEqual([
      {
        ref: "main",
        status: expect.stringMatching(/^origin: .*\(stale info\)\nbackup: .*\(stale info\)$/),
        remoteUpdatedSinceCheckout: false,
        staleInfoRefs: ["origin/main", "backup/main"]
      }
    ]);
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
        remoteUpdatedSinceCheckout: true,
        staleInfoRefs: []
      },
      { ref: "side", status: null, remoteUpdatedSinceCheckout: false, staleInfoRefs: [] }
    ]);
    expect(remoteMain(world.remote)).toBe(matesTip);
    expect(bareGit(["rev-parse", "side"], world.remote).trim()).toBe(rev(world.local, "side"));
  });

  it("names the tracking ref of a branch refused for stale info", async () => {
    const world = makeWorld();
    teammatePushes(world);
    amendTip(world.local, "rewritten");

    const results = await pushBranches(simpleGit(world.local), {
      branchNames: ["main"],
      remotes: ["origin"],
      forceMode: "forceWithLease"
    });

    expect(results).toEqual([
      {
        ref: "main",
        status: expect.stringMatching(/^\[rejected\]\s+main -> main \(stale info\)$/),
        remoteUpdatedSinceCheckout: false,
        staleInfoRefs: ["origin/main"]
      }
    ]);
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
