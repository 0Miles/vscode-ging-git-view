import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { compareCommits } from "@/backend/queries/compareCommits";

import { git, makeRepo } from "@tests/backend/helpers";

const repos: string[] = [];

function newRepo(): string {
  const r = makeRepo();
  repos.push(r);
  return r;
}

function revParse(repo: string, ref: string): string {
  return cp.execFileSync("git", ["rev-parse", ref], { cwd: repo }).toString().trim();
}

afterEach(() => {
  for (const r of repos.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("compareCommits", () => {
  it("lists files added, modified and deleted between two commits", async () => {
    const r = newRepo(); // root commit adds "f"
    const first = revParse(r, "HEAD");
    fs.writeFileSync(path.join(r, "f"), "modified content"); // modify f
    fs.writeFileSync(path.join(r, "added.txt"), "new"); // add a file
    git(["add", "."], r);
    git(["commit", "-m", "second"], r);
    const second = revParse(r, "HEAD");

    const result = await compareCommits(simpleGit(r), { fromHash: first, toHash: second });
    expect(result.fileChanges).not.toBeNull();
    const byPath = Object.fromEntries(result.fileChanges!.map((c) => [c.newFilePath, c]));
    expect(byPath["f"].type).toBe("M");
    expect(byPath["added.txt"].type).toBe("A");
  });

  it("reports additions and deletions for a modified file", async () => {
    const r = newRepo();
    const first = revParse(r, "HEAD");
    fs.writeFileSync(path.join(r, "f"), "line1\nline2\nline3\n");
    git(["add", "."], r);
    git(["commit", "-m", "grow f"], r);
    const second = revParse(r, "HEAD");

    const result = await compareCommits(simpleGit(r), { fromHash: first, toHash: second });
    const changed = result.fileChanges!.find((c) => c.newFilePath === "f");
    expect(changed).toBeDefined();
    expect(changed!.additions).toEqual(expect.any(Number));
    expect(changed!.deletions).toEqual(expect.any(Number));
  });

  it("is direction-sensitive (A→B reports the inverse of B→A)", async () => {
    const r = newRepo();
    const first = revParse(r, "HEAD");
    fs.writeFileSync(path.join(r, "added.txt"), "new");
    git(["add", "."], r);
    git(["commit", "-m", "add file"], r);
    const second = revParse(r, "HEAD");

    const forward = await compareCommits(simpleGit(r), { fromHash: first, toHash: second });
    const backward = await compareCommits(simpleGit(r), { fromHash: second, toHash: first });
    expect(forward.fileChanges!.find((c) => c.newFilePath === "added.txt")!.type).toBe("A");
    expect(backward.fileChanges!.find((c) => c.oldFilePath === "added.txt")!.type).toBe("D");
  });

  it("returns an empty list when the two commits are identical", async () => {
    const r = newRepo();
    const hash = revParse(r, "HEAD");
    const result = await compareCommits(simpleGit(r), { fromHash: hash, toHash: hash });
    expect(result.fileChanges).toEqual([]);
  });

  it("returns fileChanges: null for an invalid commit hash", async () => {
    const r = newRepo();
    const hash = revParse(r, "HEAD");
    const result = await compareCommits(simpleGit(r), { fromHash: hash, toHash: "deadbeef1234" });
    expect(result).toEqual({ fileChanges: null });
  });

  it("returns non-ASCII paths unescaped", async () => {
    const r = newRepo();
    const first = revParse(r, "HEAD");
    const fileName = "файл-測試-ä.txt";
    fs.writeFileSync(path.join(r, fileName), "content");
    git(["add", "."], r);
    git(["commit", "-m", "add unicode file"], r);
    const second = revParse(r, "HEAD");

    const result = await compareCommits(simpleGit(r), { fromHash: first, toHash: second });
    expect(result.fileChanges!.some((c) => c.newFilePath === fileName)).toBe(true);
  });
});
