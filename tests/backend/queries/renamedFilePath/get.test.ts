import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { getNewPathOfRenamedFile } from "@/backend/queries/renamedFilePath";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("getNewPathOfRenamedFile", () => {
  it("returns the new path when the file was renamed since the commit", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "old.txt"), "some stable content\n");
    git(["add", "."], repo);
    git(["commit", "-m", "add old.txt"], repo);
    const commit = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    git(["mv", "old.txt", "new.txt"], repo);
    git(["commit", "-m", "rename old.txt to new.txt"], repo);

    expect(await getNewPathOfRenamedFile(simpleGit(repo), commit, "old.txt")).toBe("new.txt");
  });

  it("returns null when the file was not renamed", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "keep.txt"), "content\n");
    git(["add", "."], repo);
    git(["commit", "-m", "add keep.txt"], repo);
    const commit = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    expect(await getNewPathOfRenamedFile(simpleGit(repo), commit, "keep.txt")).toBeNull();
  });

  it("returns null for an unknown file", async () => {
    repo = makeRepo();
    const commit = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    expect(await getNewPathOfRenamedFile(simpleGit(repo), commit, "nope.txt")).toBeNull();
  });
});
