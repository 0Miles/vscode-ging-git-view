import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { blameFile, readUserEmail } from "@/backend/queries/blameFile";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

const repos: string[] = [];
function newRepo(): string {
  const r = makeRepo();
  repos.push(r);
  return r;
}
function head(repo: string): string {
  return cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}
function commit(repo: string, message: string, author: string, unixTime: number) {
  git(["add", "-A"], repo);
  git(["commit", "-m", message, `--author=${author}`, `--date=${unixTime} +0000`], repo);
}

function blameSpawned(log: string[][]) {
  return log.some((args) => args.includes("blame"));
}

afterEach(() => {
  for (const r of repos.splice(0)) rmrf(r);
});

describe("blameFile (real git)", () => {
  it("reports each line's commit, author, time, summary and original line", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "one\ntwo\n");
    commit(r, "add a", "Al <Al@Example.com>", 1600000000);
    const first = head(r);
    fs.writeFileSync(path.join(r, "a.txt"), "zero\none\ntwo changed\n");
    commit(r, "rework a\n\nwith a body", "Bea <bea@example.com>", 1700000000);
    const second = head(r);

    const lines = await blameFile({ gitPath: "git", repoPath: r, filePath: "a.txt" });

    expect(lines).toEqual([
      {
        sha: second,
        uncommitted: false,
        authorName: "Bea",
        authorEmail: "bea@example.com",
        authorTime: 1700000000,
        summary: "rework a",
        originalLine: 1,
        filename: "a.txt",
        previous: { sha: first, filename: "a.txt" }
      },
      {
        sha: first,
        uncommitted: false,
        authorName: "Al",
        authorEmail: "Al@Example.com",
        authorTime: 1600000000,
        summary: "add a",
        originalLine: 1,
        filename: "a.txt",
        previous: null
      },
      expect.objectContaining({ sha: second, originalLine: 3 })
    ]);
  });

  it("names the file as it was before a rename, in the line's commit and its previous", async () => {
    const r = newRepo();
    // Enough unchanged lines that git still sees the edited file as a rename.
    const kept = "kept 1\nkept 2\nkept 3\nkept 4\n";
    fs.writeFileSync(path.join(r, "old.txt"), kept + "edited\n");
    commit(r, "add old", "Al <al@example.com>", 1600000000);
    const first = head(r);
    git(["mv", "old.txt", "new.txt"], r);
    fs.writeFileSync(path.join(r, "new.txt"), kept + "edited again\n");
    commit(r, "rename and edit", "Al <al@example.com>", 1700000000);

    const lines = await blameFile({ gitPath: "git", repoPath: r, filePath: "new.txt" });

    expect(lines?.[0]).toMatchObject({ sha: first, filename: "old.txt", previous: null });
    expect(lines?.[4]).toMatchObject({
      filename: "new.txt",
      previous: { sha: first, filename: "old.txt" }
    });
  });

  it("marks lines saved to disk but not committed as uncommitted", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "one\n");
    commit(r, "add a", "Al <al@example.com>", 1600000000);
    fs.writeFileSync(path.join(r, "a.txt"), "one\nsaved, not committed\n");

    const lines = await blameFile({ gitPath: "git", repoPath: r, filePath: "a.txt" });

    expect(lines?.map((l) => l.uncommitted)).toEqual([false, true]);
  });

  it("blames contents handed over on stdin instead of the file on disk", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "one\ntwo\n");
    commit(r, "add a", "Al <al@example.com>", 1600000000);

    const lines = await blameFile({
      gitPath: "git",
      repoPath: r,
      filePath: "a.txt",
      contents: "inserted\none\ntwo\n"
    });

    expect(lines?.map((l) => l.uncommitted)).toEqual([true, false, false]);
  });

  it("lines unsaved edits up with the editor: edited lines uncommitted, the rest at their original lines", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "one\ntwo\nthree\nfour\n");
    commit(r, "add a", "Al <al@example.com>", 1600000000);
    const first = head(r);
    fs.writeFileSync(path.join(r, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    commit(r, "add five", "Bea <bea@example.com>", 1700000000);
    const second = head(r);
    // Saved on disk: untouched since the last commit. In the editor: a line
    // inserted at the top and "three" rewritten.
    const contents = "new top\none\ntwo\nTHREE\nfour\nfive\n";

    const lines = await blameFile({ gitPath: "git", repoPath: r, filePath: "a.txt", contents });

    expect(lines?.map((l) => (l.uncommitted ? "uncommitted" : [l.sha, l.originalLine]))).toEqual([
      "uncommitted",
      [first, 1],
      [first, 2],
      "uncommitted",
      [first, 4],
      [second, 5]
    ]);
  });

  // VS Code hands over an editor's text without the file's UTF-8 BOM.
  it("keeps the first line committed when the editor's text lacks the file's BOM", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "﻿one\ntwo\n");
    commit(r, "add a", "Al <al@example.com>", 1600000000);

    const lines = await blameFile({
      gitPath: "git",
      repoPath: r,
      filePath: "a.txt",
      contents: "one\ntwo\nthree\n"
    });

    expect(lines?.map((l) => l.uncommitted)).toEqual([false, false, true]);
  });

  // The editor's text can't be turned back into the file's own bytes (Big5,
  // Latin-1, ...), so every line with a non-ASCII character would look changed.
  it("gives no result for unsaved edits to a file saved in an encoding other than UTF-8", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in Latin-1
    commit(r, "add a", "Al <al@example.com>", 1600000000);

    const lines = await blameFile({
      gitPath: "git",
      repoPath: r,
      filePath: "a.txt",
      contents: "café\nmore\n"
    });

    expect(lines).toBeNull();
  });

  it("blames a linked worktree's file against that worktree's own history", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "main line\n");
    commit(r, "on main", "Al <al@example.com>", 1600000000);
    const wt = path.join(r, ".wt");
    git(["worktree", "add", "-b", "side", wt], r);
    fs.writeFileSync(path.join(wt, "a.txt"), "side line\n");
    commit(wt, "on side", "Bea <bea@example.com>", 1700000000);

    const lines = await blameFile({ gitPath: "git", repoPath: wt, filePath: "a.txt" });

    expect(lines?.map((l) => [l.sha, l.summary])).toEqual([[head(wt), "on side"]]);
  });

  // `-text` in .gitattributes only switches off EOL conversion; it says nothing
  // about the content being binary.
  it("still blames a text file whose attributes say -text", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, ".gitattributes"), "*.bat -text\n");
    fs.writeFileSync(path.join(r, "run.bat"), "@echo off\r\necho hi\r\n");
    commit(r, "add bat", "Al <al@example.com>", 1600000000);

    const lines = await blameFile({ gitPath: "git", repoPath: r, filePath: "run.bat" });

    expect(lines?.map((l) => l.summary)).toEqual(["add bat", "add bat"]);
  });

  describe("skips without running blame", () => {
    it("a binary file", async () => {
      const r = newRepo();
      fs.writeFileSync(path.join(r, "bin.dat"), Buffer.from([0x50, 0x00, 0x01, 0x02, 0x0a]));
      commit(r, "add bin", "Al <al@example.com>", 1600000000);
      const log: string[][] = [];

      const lines = await blameFile({
        gitPath: "git",
        repoPath: r,
        filePath: "bin.dat",
        onCommand: (_c, args) => log.push(args)
      });

      expect(lines).toBeNull();
      expect(blameSpawned(log)).toBe(false);
    });

    it("a file over 1 MB", async () => {
      const r = newRepo();
      fs.writeFileSync(path.join(r, "big.txt"), "x".repeat(1024 * 1024) + "\n");
      commit(r, "add big", "Al <al@example.com>", 1600000000);
      const log: string[][] = [];

      const lines = await blameFile({
        gitPath: "git",
        repoPath: r,
        filePath: "big.txt",
        onCommand: (_c, args) => log.push(args)
      });

      expect(lines).toBeNull();
      expect(blameSpawned(log)).toBe(false);
    });

    it("a file git does not track, ignored or not", async () => {
      const r = newRepo();
      fs.writeFileSync(path.join(r, ".gitignore"), "ignored.txt\n");
      commit(r, "ignore", "Al <al@example.com>", 1600000000);
      fs.writeFileSync(path.join(r, "ignored.txt"), "ignored\n");
      fs.writeFileSync(path.join(r, "untracked.txt"), "untracked\n");
      const log: string[][] = [];
      const onCommand = (_c: string, args: string[]) => log.push(args);

      expect(
        await blameFile({ gitPath: "git", repoPath: r, filePath: "ignored.txt", onCommand })
      ).toBeNull();
      expect(
        await blameFile({ gitPath: "git", repoPath: r, filePath: "untracked.txt", onCommand })
      ).toBeNull();
      expect(blameSpawned(log)).toBe(false);
    });
  });

  it("gives up with no result, rather than throwing, when git runs past the deadline", async () => {
    const r = newRepo();
    // No git command completes within a millisecond of being spawned.
    const lines = await blameFile({
      gitPath: "git",
      repoPath: r,
      filePath: "f",
      deadline: Date.now() + 1
    });
    expect(lines).toBeNull();
  });

  it("spawns nothing once the deadline has passed", async () => {
    const r = newRepo();
    const log: string[][] = [];
    const lines = await blameFile({
      gitPath: "git",
      repoPath: r,
      filePath: "f",
      deadline: Date.now() - 1,
      onCommand: (_c, args) => log.push(args)
    });
    expect(lines).toBeNull();
    expect(log).toEqual([]);
  });

  it("reports no result when git fails", async () => {
    const r = newRepo();
    const lines = await blameFile({ gitPath: "git", repoPath: r, filePath: "missing.txt" });
    expect(lines).toBeNull();
  });
});

describe("readUserEmail (real git)", () => {
  it("reads the repository's effective user.email", async () => {
    const r = newRepo(); // makeRepo sets user.email = t@t.com in .git/config
    expect(await readUserEmail({ gitPath: "git", repoPath: r })).toBe("t@t.com");
  });

  it("is empty, not an error, past the deadline", async () => {
    const r = newRepo();
    expect(await readUserEmail({ gitPath: "git", repoPath: r, deadline: Date.now() - 1 })).toBe("");
  });
});
