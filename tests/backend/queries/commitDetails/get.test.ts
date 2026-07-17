import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commitDetails } from "@/backend/queries/commitDetails";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let commitHash: string;

beforeAll(() => {
  repo = makeRepo();
  commitHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("commitDetails", () => {
  it("returns commit details with expected fields", async () => {
    const result = await commitDetails(simpleGit(repo), {
      commitHash,
      useMailmap: false
    });
    expect(result).toEqual({
      commitDetails: {
        hash: commitHash,
        parents: expect.any(Array),
        author: expect.any(String),
        email: expect.any(String),
        committer: expect.any(String),
        committerEmail: expect.any(String),
        authorDate: expect.any(Number),
        commitDate: expect.any(Number),
        body: expect.any(String),
        fileChanges: expect.any(Array)
      }
    });
    expect(result.commitDetails!.authorDate).toBeGreaterThan(0);
  });

  it("returns an empty parents array for a root commit", async () => {
    const result = await commitDetails(simpleGit(repo), { commitHash, useMailmap: false });
    expect(result.commitDetails!.parents).toEqual([]);
  });

  it("returns file changes for the initial commit", async () => {
    const result = await commitDetails(simpleGit(repo), {
      commitHash,
      useMailmap: false
    });
    expect(result.commitDetails).not.toBeNull();
    expect(result.commitDetails!.fileChanges.length).toBeGreaterThan(0);
  });

  it("returns commitDetails: null for an invalid commit hash", async () => {
    const result = await commitDetails(simpleGit(repo), {
      commitHash: "deadbeef1234",
      useMailmap: false
    });
    expect(result).toEqual({ commitDetails: null });
  });

  it("includes additions and deletions for a modified file", async () => {
    const repo2 = makeRepo();
    try {
      fs.writeFileSync(path.join(repo2, "f"), "modified content");
      git(["add", "."], repo2);
      git(["commit", "-m", "mod"], repo2);
      const hash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo2 }).toString().trim();

      const result = await commitDetails(simpleGit(repo2), {
        commitHash: hash,
        useMailmap: false
      });
      expect(result.commitDetails).not.toBeNull();
      const changed = result.commitDetails!.fileChanges.find((f) => f.newFilePath === "f");
      expect(changed).toBeDefined();
      expect(changed!.additions).toEqual(expect.any(Number));
      expect(changed!.deletions).toEqual(expect.any(Number));
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true });
    }
  });

  it("includes author and commit dates and committer email", async () => {
    const result = await commitDetails(simpleGit(repo), {
      commitHash,
      useMailmap: false
    });
    expect(result).toEqual({
      commitDetails: {
        hash: commitHash,
        parents: expect.any(Array),
        author: expect.any(String),
        email: expect.any(String),
        committer: expect.any(String),
        committerEmail: expect.any(String),
        authorDate: expect.any(Number),
        commitDate: expect.any(Number),
        body: expect.any(String),
        fileChanges: expect.any(Array)
      }
    });
    expect(result.commitDetails!.authorDate).toBeGreaterThan(0);
  });

  it("body contains the commit message", async () => {
    const result = await commitDetails(simpleGit(repo), {
      commitHash,
      useMailmap: false
    });
    expect(result.commitDetails!.body).toContain("init");
  });

  it("handles a filename containing a double quote", async () => {
    const repo2 = makeRepo();
    const fileName = String.fromCharCode(97, 34, 98) + ".txt"; // a"b.txt
    try {
      fs.writeFileSync(path.join(repo2, fileName), "content");
      git(["add", "."], repo2);
      git(["commit", "-m", "add quoted-name file"], repo2);
      const hash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo2 }).toString().trim();
      const result = await commitDetails(simpleGit(repo2), { commitHash: hash, useMailmap: false });
      const changed = result.commitDetails!.fileChanges.find((f) => f.newFilePath === fileName);
      expect(changed).toBeDefined();
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true });
    }
  });

  it("returns non-ASCII file paths unescaped", async () => {
    const repo2 = makeRepo();
    const fileName = "файл-測試-ä.txt";
    try {
      fs.writeFileSync(path.join(repo2, fileName), "content");
      git(["add", "."], repo2);
      git(["commit", "-m", "add unicode file"], repo2);
      const hash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo2 }).toString().trim();

      const result = await commitDetails(simpleGit(repo2), {
        commitHash: hash,
        useMailmap: false
      });
      // Without `core.quotePath=false`, git would report this as an octal-escaped
      // string like "\\321\\204..."; we expect the raw UTF-8 path instead.
      const changed = result.commitDetails!.fileChanges.find((f) => f.newFilePath === fileName);
      expect(changed).toBeDefined();
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true });
    }
  });

  it("includes a stash's untracked files only when isStash is set", async () => {
    const r = makeRepo();
    try {
      fs.writeFileSync(path.join(r, "f"), "changed"); // tracked change
      fs.writeFileSync(path.join(r, "untracked.txt"), "u"); // untracked
      git(["stash", "push", "-u", "-m", "wip"], r);
      const stashHash = cp
        .execFileSync("git", ["rev-parse", "stash@{0}"], { cwd: r })
        .toString()
        .trim();

      const withStash = await commitDetails(simpleGit(r), {
        commitHash: stashHash,
        useMailmap: false,
        isStash: true
      });
      expect(
        withStash.commitDetails!.fileChanges.some((f) => f.newFilePath === "untracked.txt")
      ).toBe(true);

      const withoutStash = await commitDetails(simpleGit(r), {
        commitHash: stashHash,
        useMailmap: false
      });
      expect(
        withoutStash.commitDetails!.fileChanges.some((f) => f.newFilePath === "untracked.txt")
      ).toBe(false);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("shows a merge commit's files relative to its first parent", async () => {
    const r = makeRepo(); // root commit adds "f"
    try {
      // main: add "on-main"; feature (from root): add "on-feature".
      fs.writeFileSync(path.join(r, "on-main"), "m");
      git(["add", "."], r);
      git(["commit", "-m", "on main"], r);
      git(["checkout", "-b", "feature", "HEAD~1"], r);
      fs.writeFileSync(path.join(r, "on-feature"), "f");
      git(["add", "."], r);
      git(["commit", "-m", "on feature"], r);
      git(["checkout", "main"], r);
      git(["merge", "--no-ff", "feature", "-m", "merge feature"], r);
      const mergeHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();

      const result = await commitDetails(simpleGit(r), {
        commitHash: mergeHash,
        useMailmap: false
      });
      const paths = result.commitDetails!.fileChanges.map((f) => f.newFilePath);
      // Relative to the first parent (main), the merge only brings in feature's file.
      expect(paths).toContain("on-feature");
      expect(paths).not.toContain("on-main"); // already present on the first parent
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });
});
