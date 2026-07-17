import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { dropCommit } from "@/backend/actions/commit";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

function commitFile(name: string, content: string) {
  fs.writeFileSync(path.join(repo, name), content);
  git(["add", "."], repo);
  git(["commit", "-m", `add ${name}`], repo);
  return cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

function subjects(): string[] {
  return cp
    .execFileSync("git", ["log", "--format=%s"], { cwd: repo })
    .toString()
    .trim()
    .split("\n");
}

describe("dropCommit", () => {
  it("removes a middle commit and replays later ones", async () => {
    repo = makeRepo();
    commitFile("a.txt", "a");
    const middle = commitFile("b.txt", "b");
    commitFile("c.txt", "c");

    await dropCommit(simpleGit(repo), { commitHash: middle });

    expect(subjects()).toEqual(["add c.txt", "add a.txt", "init"]);
    // The dropped commit's file is gone; the later commit's file remains.
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(true);
  });

  it("throws when dropping the commit would conflict", async () => {
    repo = makeRepo();
    const target = commitFile("shared.txt", "first");
    // A later commit edits the same file, so dropping `target` conflicts.
    fs.writeFileSync(path.join(repo, "shared.txt"), "first\nsecond");
    git(["add", "."], repo);
    git(["commit", "-m", "edit shared"], repo);

    await expect(dropCommit(simpleGit(repo), { commitHash: target })).rejects.toThrow();
    // Clean up the in-progress rebase so afterEach can remove the repo cleanly.
    try {
      git(["rebase", "--abort"], repo);
    } catch {
      // ignore
    }
  });
});
