import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { resetFileToRevision } from "@/backend/actions/commit";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("resetFileToRevision", () => {
  it("restores the working-tree file to its content at the commit", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "doc.txt"), "original");
    git(["add", "."], repo);
    git(["commit", "-m", "add doc"], repo);
    const commitHash = cp
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
      .toString()
      .trim();

    // Modify the working copy, then reset it back to the commit's version.
    fs.writeFileSync(path.join(repo, "doc.txt"), "modified");
    await resetFileToRevision(simpleGit(repo), { commitHash, filePath: "doc.txt" });

    expect(fs.readFileSync(path.join(repo, "doc.txt"), "utf8")).toBe("original");
  });

  it("throws for a path that doesn't exist at the commit", async () => {
    repo = makeRepo();
    const commitHash = cp
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    await expect(
      resetFileToRevision(simpleGit(repo), { commitHash, filePath: "nope.txt" })
    ).rejects.toThrow();
  });
});
