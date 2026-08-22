import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rebaseOnto } from "@/backend/actions/rebase";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;

function commit(name: string) {
  fs.writeFileSync(path.join(repo, name + ".txt"), name);
  git(["add", "."], repo);
  git(["commit", "-m", name], repo);
  return cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

function log(ref: string): string[] {
  return cp
    .execFileSync("git", ["log", "--format=%s", ref], { cwd: repo })
    .toString()
    .trim()
    .split("\n");
}

// base ← keep ← drop-me ← wanted-1 ← wanted-2 (branch "topic"),
// and base ← target on "main". The commits to move are the two after
// "drop-me", so the range is `drop-me..topic` replayed onto "target".
let base: string, dropMe: string, target: string;

beforeEach(() => {
  repo = makeRepo();
  base = commit("base");
  git(["checkout", "-b", "topic"], repo);
  commit("keep");
  dropMe = commit("drop-me");
  commit("wanted-1");
  commit("wanted-2");
  git(["checkout", "main"], repo);
  target = commit("target");
  git(["checkout", "topic"], repo);
});

afterEach(() => {
  rmrf(repo);
});

describe("rebaseOnto", () => {
  it("replays only the commits after upstream, and moves the named branch", async () => {
    await rebaseOnto(simpleGit(repo), { newBase: target, upstream: dropMe, tip: "topic" });

    // topic now sits on target and carries only the two commits after drop-me.
    expect(log("topic")).toEqual(["wanted-2", "wanted-1", "target", "base", "init"]);
    // The branch moved, so HEAD is still on it rather than detached.
    expect(
      cp.execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo }).toString().trim()
    ).toBe("topic");
  });

  it("leaves HEAD detached when the tip is given as a hash", async () => {
    const tip = cp.execFileSync("git", ["rev-parse", "topic"], { cwd: repo }).toString().trim();

    await rebaseOnto(simpleGit(repo), { newBase: target, upstream: dropMe, tip });

    expect(log("HEAD")).toEqual(["wanted-2", "wanted-1", "target", "base", "init"]);
    // topic itself never moved — the replayed commits are a second copy.
    expect(log("topic")).toEqual(["wanted-2", "wanted-1", "drop-me", "keep", "base", "init"]);
    expect(() =>
      cp.execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, stdio: "pipe" })
    ).toThrow();
  });

  it("throws when the new base does not exist", async () => {
    await expect(
      rebaseOnto(simpleGit(repo), { newBase: "nonexistent-ref", upstream: base, tip: "topic" })
    ).rejects.toThrow();
  });
});
