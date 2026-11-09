import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pushBranch, pushBranches, staleLeaseInfoRefs } from "@ging/core/backend/actions/branch";
import { isRemoteUpdatedSinceCheckoutError } from "@ging/core/backend/utils/gitError";
import type { ActionPayload } from "@ging/shared/backend/types";

import { bareGit, git, makeRepo, rejection, rmrf } from "@ging/core/tests/helpers";

// The Push dialog's advanced options name a target branch on the remote, which
// need not be the source's own name (#303). The push then spells out the full
// destination, `<branch>:refs/heads/<target>`, so a target the remote does not
// have yet is created rather than left to git's guess about what kind of ref
// an unqualified name means.

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmrf(dir);
  dirs = [];
});

/** A local repo with an `origin` bare remote that has nothing on it yet. */
function makeWorld(): { local: string; remote: string } {
  const local = makeRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-target-remote-"));
  dirs.push(local, remote);
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], local);
  return { local, remote };
}

function rev(repo: string, ref: string): string {
  return cp.execFileSync("git", ["rev-parse", ref], { cwd: repo }).toString().trim();
}

/** The remote's refs/heads, as `name hash` lines. */
function remoteHeads(remote: string): string[] {
  return bareGit(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], remote)
    .trim()
    .split("\n")
    .filter((l) => l !== "");
}

describe("pushBranch to a named target branch", () => {
  it("creates the target on the remote, at the source's tip, and nothing under the source's name", async () => {
    const { local, remote } = makeWorld();

    await pushBranch(simpleGit(local), {
      branchName: "main",
      remotes: ["origin"],
      forceMode: "normal",
      targetBranch: "review/main"
    });

    expect(remoteHeads(remote)).toEqual([`review/main ${rev(local, "main")}`]);
  });

  it("updates a target the remote already has, leaving the source's own name alone", async () => {
    const { local, remote } = makeWorld();
    git(["push", "origin", "main", "main:refs/heads/review"], local);
    const pushedTip = rev(local, "main");
    fs.writeFileSync(path.join(local, "more.txt"), "more");
    git(["add", "."], local);
    git(["commit", "-m", "more work"], local);

    await pushBranch(simpleGit(local), {
      branchName: "main",
      remotes: ["origin"],
      forceMode: "normal",
      targetBranch: "review"
    });

    expect(remoteHeads(remote)).toEqual([`main ${pushedTip}`, `review ${rev(local, "main")}`]);
  });

  it("creates a target the remote does not have under a lease", async () => {
    const { local, remote } = makeWorld();

    await pushBranch(simpleGit(local), {
      branchName: "main",
      remotes: ["origin"],
      forceMode: "forceWithLease",
      targetBranch: "review"
    });

    expect(remoteHeads(remote)).toEqual([`review ${rev(local, "main")}`]);
  });
});

// A bare `--force-with-lease` protects the destination with the tracking ref
// git keeps for it, so for a named target the lease is `origin/<target>`, and
// a refusal for stale info has to name that ref, not `origin/<source>`
// (ADR-0025): that is the one the user would fetch and integrate.
describe("pushBranch to a named target under a lease", () => {
  it("names the target's tracking ref when the lease is refused for stale info", async () => {
    const { local, remote } = makeWorld();
    // A teammate's `review` the local repo never fetched, plus a local
    // `origin/main` that is perfectly current — the wrong ref to blame.
    git(["push", "origin", "main"], local);
    git(["push", "origin", "main:refs/heads/review"], local);
    git(["update-ref", "-d", "refs/remotes/origin/review"], local);
    fs.writeFileSync(path.join(local, "mine.txt"), "mine");
    git(["add", "."], local);
    git(["commit", "--amend", "-m", "rewritten"], local);
    const remoteReview = bareGit(["rev-parse", "review"], remote).trim();

    const error = await rejection(
      pushBranch(simpleGit(local), {
        branchName: "main",
        remotes: ["origin"],
        forceMode: "forceWithLease",
        targetBranch: "review"
      })
    );

    expect(staleLeaseInfoRefs(error)).toEqual(["origin/review"]);
    expect(bareGit(["rev-parse", "review"], remote).trim()).toBe(remoteReview);
  });

  // git reads the integration check (`push.useForceIfIncludes`) off the reflog
  // of the *local* branch named like the remote one — `refs/heads/review`
  // here, not the `main` being pushed — and a branch that does not exist has
  // nothing in its reflog. So under the ADR-0025 lease an existing target of
  // another name is refused as unintegrated even with its tracking ref
  // current; only Force overwrites it. Pinned so a change to that is a
  // decision, not an accident.
  it("refuses to overwrite an existing target of another name, its tracking ref current or not", async () => {
    const { local, remote } = makeWorld();
    git(["push", "origin", "main:refs/heads/review"], local);
    git(["fetch", "origin"], local);
    fs.writeFileSync(path.join(local, "mine.txt"), "mine");
    git(["add", "."], local);
    git(["commit", "--amend", "-m", "rewritten"], local);
    const remoteReview = bareGit(["rev-parse", "review"], remote).trim();

    const error = await rejection(
      pushBranch(simpleGit(local), {
        branchName: "main",
        remotes: ["origin"],
        forceMode: "forceWithLease",
        targetBranch: "review"
      })
    );

    expect(isRemoteUpdatedSinceCheckoutError(error)).toBe(true);
    expect(bareGit(["rev-parse", "review"], remote).trim()).toBe(remoteReview);

    await pushBranch(simpleGit(local), {
      branchName: "main",
      remotes: ["origin"],
      forceMode: "force",
      targetBranch: "review"
    });
    expect(bareGit(["rev-parse", "review"], remote).trim()).toBe(rev(local, "main"));
  });
});

// Without a target nothing about the push may change: the collapsed dialog
// sends what it always sent, and git must be handed what it always was.
describe("pushBranch without a target", () => {
  it.each([
    ["normal", ["push", "origin", "main"]],
    ["force", ["push", "--force", "origin", "main"]],
    [
      "forceWithLease",
      ["-c", "push.useForceIfIncludes=true", "push", "--force-with-lease", "origin", "main"]
    ]
  ] as const)("hands git the same arguments as before in %s mode", async (forceMode, args) => {
    const { local } = makeWorld();
    const client = simpleGit(local);
    const raw = vi.spyOn(client, "raw");

    await pushBranch(client, { branchName: "main", remotes: ["origin"], forceMode });

    expect(raw.mock.calls).toEqual([[args]]);
  });

  it("leaves the batch push's arguments as they were", async () => {
    const { local } = makeWorld();
    const client = simpleGit(local);
    const raw = vi.spyOn(client, "raw");

    const pushAll = (forceMode: ActionPayload<"pushBranch">["forceMode"]) =>
      pushBranches(client, { branchNames: ["main"], remotes: ["origin"], forceMode });
    await pushAll("normal");
    await pushAll("force");
    await pushAll("forceWithLease");

    expect(raw.mock.calls.map((c) => c[0])).toEqual([
      ["push", "origin", "main"],
      ["push", "--force", "origin", "main"],
      ["-c", "push.useForceIfIncludes=true", "push", "--force-with-lease", "origin", "main"]
    ]);
  });
});
