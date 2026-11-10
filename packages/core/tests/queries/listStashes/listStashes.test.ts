import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listStashes } from "@ging/core/backend/queries/listStashes";

import { makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

let repo: string;

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  rmrf(repo);
});

describe("listStashes", () => {
  it("returns an empty array on a clean repo", async () => {
    expect(await listStashes(simpleGit(repo))).toEqual([]);
  });

  it("returns stashes in newest-first order with parsed message and date", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "first"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "z");
    cp.execFileSync("git", ["stash", "push", "-m", "second"], { cwd: repo });

    const stashes = await listStashes(simpleGit(repo));

    expect(stashes).toHaveLength(2);
    expect(stashes[0].ref).toBe("stash@{0}");
    expect(stashes[0].message).toContain("second");
    expect(stashes[1].ref).toBe("stash@{1}");
    expect(stashes[1].message).toContain("first");
    expect(stashes[0].date).toBeTypeOf("number");
  });

  it("names each stash by its commit's SHA, the identity the graph keys it by", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "first"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "z");
    cp.execFileSync("git", ["stash", "push", "-m", "second"], { cwd: repo });

    const stashes = await listStashes(simpleGit(repo));

    expect(stashes.map((s) => s.hash)).toEqual([rev(repo, "stash@{0}"), rev(repo, "stash@{1}")]);
  });

  it("keeps a tab in a stash's message", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "a\tb"], { cwd: repo });

    const [stash] = await listStashes(simpleGit(repo));

    expect(stash.message).toBe("On main: a\tb");
    expect(stash.hash).toBe(rev(repo, "stash@{0}"));
  });

  it("sequential index numbering tolerates blank lines in stdout", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "a"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "z");
    cp.execFileSync("git", ["stash", "push", "-m", "b"], { cwd: repo });

    const stashes = await listStashes(simpleGit(repo));

    expect(stashes.map((s) => s.index)).toEqual([0, 1]);
  });
});
