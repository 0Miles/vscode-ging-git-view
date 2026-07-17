import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listStashes } from "@/backend/queries/listStashes";

import { makeRepo } from "@tests/backend/helpers";

let repo: string;

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
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

  it("sequential index numbering tolerates blank lines in stdout", async () => {
    fs.writeFileSync(path.join(repo, "f"), "y");
    cp.execFileSync("git", ["stash", "push", "-m", "a"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "z");
    cp.execFileSync("git", ["stash", "push", "-m", "b"], { cwd: repo });

    const stashes = await listStashes(simpleGit(repo));

    expect(stashes.map((s) => s.index)).toEqual([0, 1]);
  });
});
