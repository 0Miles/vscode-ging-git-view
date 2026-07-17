import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stashApply, stashDrop, stashPop, stashPush } from "@/backend/actions/scm";

import { makeRepo } from "@tests/backend/helpers";

let repo: string;

function stashCount(): number {
  const out = cp.execFileSync("git", ["stash", "list"], { cwd: repo }).toString().trim();
  if (!out) return 0;
  return out.split("\n").length;
}

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("stashPush", () => {
  it("stashes tracked changes with a message", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");

    await stashPush(simpleGit(repo), { message: "wip" });

    expect(stashCount()).toBe(1);
    const list = cp.execFileSync("git", ["stash", "list"], { cwd: repo }).toString();
    expect(list).toContain("wip");
  });

  it("includes untracked files when includeUntracked=true", async () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "x");

    await stashPush(simpleGit(repo), { includeUntracked: true });

    expect(stashCount()).toBe(1);
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(false);
  });
});

describe("stashPop / stashApply / stashDrop", () => {
  it("pops the named stash and restores changes", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "wip"], { cwd: repo });
    expect(stashCount()).toBe(1);

    await stashPop(simpleGit(repo), { ref: "stash@{0}" });

    expect(stashCount()).toBe(0);
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("y");
  });

  it("applies a stash without removing it", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "wip"], { cwd: repo });

    await stashApply(simpleGit(repo), { ref: "stash@{0}" });

    expect(stashCount()).toBe(1);
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("y");
  });

  it("drops a stash entry", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "wip"], { cwd: repo });

    await stashDrop(simpleGit(repo), { ref: "stash@{0}" });

    expect(stashCount()).toBe(0);
  });
});
