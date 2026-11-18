import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { blameFileAtRevision } from "@ging/core/backend/queries/blameFile";

import { git, makeRepo, makeTempDir, rev, rmrf } from "@ging/core/tests/helpers";

// A file blamed as a commit has it (#409): what the desktop app's read-only
// file viewer shows blame for. Real git, as the working tree's blame is
// (blame.test.ts).

const dirs: string[] = [];
function newRepo(): string {
  const r = makeRepo();
  dirs.push(r);
  return r;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

const head = (repo: string) => rev(repo, "HEAD");
function commit(repo: string, message: string, author: string, unixTime: number) {
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", message, `--author=${author}`, `--date=${unixTime} +0000`], repo);
}

/** A blob of `content` in `repo`, for a path its working tree could not hold. */
function blob(repo: string, content: string): string {
  return cp
    .execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: content })
    .toString()
    .trim();
}

/** Add `file` to the index with `content`, past the checks a checkout on
 *  Windows makes of a name (`:` and `*` cannot be on its disk). */
function addToIndex(repo: string, file: string, content: string) {
  git(
    [
      "-c",
      "core.protectNTFS=false",
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob(repo, content)},${file}`
    ],
    repo
  );
}

/** A command log, and the handler that writes it. */
function logged() {
  const log: string[][] = [];
  return { log, onCommand: (_c: string, args: string[]) => log.push(args) };
}

const blame = (repo: string, revision: string, filePath: string, more = {}) =>
  blameFileAtRevision({ gitPath: "git", repoPath: repo, revision, filePath, ...more });

describe("blameFileAtRevision (real git)", () => {
  it("blames the file as the commit has it, not as the working tree or a later commit does", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "one\ntwo\n");
    commit(r, "add a", "Al <al@example.com>", 1600000000);
    const first = head(r);
    fs.writeFileSync(path.join(r, "a.txt"), "one\ntwo changed\n");
    commit(r, "change two", "Bea <bea@example.com>", 1700000000);
    const second = head(r);
    fs.writeFileSync(path.join(r, "a.txt"), "on disk only\n");

    const atSecond = await blame(r, second, "a.txt");
    const atFirst = await blame(r, first, "a.txt");

    expect(atSecond?.map((l) => [l.sha, l.uncommitted, l.originalLine])).toEqual([
      [first, false, 1],
      [second, false, 2]
    ]);
    expect(atSecond?.[1]).toMatchObject({
      authorName: "Bea",
      authorEmail: "bea@example.com",
      authorTime: 1700000000,
      summary: "change two",
      previous: { sha: first, filename: "a.txt" }
    });
    expect(atFirst?.map((l) => l.sha)).toEqual([first, first]);
  });

  it("blames at a parent of a commit, named by `^`", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "one\n");
    commit(r, "add a", "Al <al@example.com>", 1600000000);
    const first = head(r);
    fs.writeFileSync(path.join(r, "a.txt"), "one\ntwo\n");
    commit(r, "add two", "Al <al@example.com>", 1700000000);

    const lines = await blame(r, `${head(r)}^`, "a.txt");

    expect(lines?.map((l) => l.sha)).toEqual([first]);
  });

  it("names the file as it was before a rename, in the line's commit and its previous", async () => {
    const r = newRepo();
    const kept = "kept 1\nkept 2\nkept 3\nkept 4\n";
    fs.writeFileSync(path.join(r, "old.txt"), kept + "edited\n");
    commit(r, "add old", "Al <al@example.com>", 1600000000);
    const first = head(r);
    git(["mv", "old.txt", "new.txt"], r);
    fs.writeFileSync(path.join(r, "new.txt"), kept + "edited again\n");
    commit(r, "rename and edit", "Al <al@example.com>", 1700000000);

    const lines = await blame(r, head(r), "new.txt");

    expect(lines?.[0]).toMatchObject({ sha: first, filename: "old.txt", previous: null });
    expect(lines?.[4]).toMatchObject({
      filename: "new.txt",
      previous: { sha: first, filename: "old.txt" }
    });
  });

  // A root commit is a boundary to `git blame` (no `--root`), and so is the
  // oldest commit of a shallow clone: nothing before it to compare with.
  it("blames a shallow clone's oldest lines to its boundary commit, with no previous", async () => {
    const origin = newRepo();
    fs.writeFileSync(path.join(origin, "a.txt"), "one\n");
    commit(origin, "add a", "Al <al@example.com>", 1600000000);
    fs.writeFileSync(path.join(origin, "a.txt"), "one\ntwo\n");
    commit(origin, "add two", "Bea <bea@example.com>", 1700000000);
    const tip = head(origin);
    const clone = path.join(makeTempDir("ging-blame-shallow-"), "clone");
    dirs.push(path.dirname(clone));
    git(["clone", "-q", "--depth", "1", `file://${origin.replace(/\\/g, "/")}`, clone], origin);

    const lines = await blame(clone, tip, "a.txt");

    expect(lines?.map((l) => [l.sha, l.summary, l.previous])).toEqual([
      [tip, "add two", null],
      [tip, "add two", null]
    ]);
  });

  // The lines are git's, split at "\n": a file in another encoding blames
  // line for line, whatever the viewer decodes it as.
  it("blames a file not in UTF-8 line for line", async () => {
    const r = newRepo();
    // "café" in windows-1252, then an ASCII line.
    fs.writeFileSync(
      path.join(r, "legacy.txt"),
      Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), Buffer.from("plain\n")])
    );
    commit(r, "add legacy", "Al <al@example.com>", 1600000000);

    const lines = await blame(r, head(r), "legacy.txt");

    expect(lines?.map((l) => [l.summary, l.originalLine])).toEqual([
      ["add legacy", 1],
      ["add legacy", 2]
    ]);
  });

  it.each([
    ["[ab].txt", "brackets, a pattern"],
    ["-dash.txt", "a leading dash"],
    [":colon.txt", "a leading colon, git's magic pathspec"],
    ["*.txt", "a wildcard that would match every .txt"],
    ["sp ace ü.txt", "spaces and a non-ASCII letter"],
    ["new\nline.txt", "a newline"]
  ])("takes %s literally: %s", async (file) => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), "a\n");
    git(["add", "a.txt"], r);
    addToIndex(r, file, "odd\n");
    git(["commit", "-q", "-m", "odd names"], r);

    const lines = await blame(r, head(r), file);

    expect(lines?.map((l) => [l.summary, l.filename])).toEqual([["odd names", file]]);
  });

  describe("blames nothing, and runs no blame,", () => {
    it("for a revision git would read as an option", async () => {
      const r = newRepo();
      const { log, onCommand } = logged();

      expect(await blame(r, "--output=x", "a.txt", { onCommand })).toBeNull();
      expect(log).toEqual([]);
    });

    it("for a file bigger than it is given", async () => {
      const r = newRepo();
      fs.writeFileSync(path.join(r, "big.txt"), "x".repeat(100) + "\n");
      commit(r, "add big", "Al <al@example.com>", 1600000000);
      const { log, onCommand } = logged();

      expect(await blame(r, head(r), "big.txt", { onCommand, maxBytes: 100 })).toBeNull();
      expect(log.some((args) => args.includes("blame"))).toBe(false);
      expect(await blame(r, head(r), "big.txt", { maxBytes: 101 })).toHaveLength(1);
    });

    it("for a file the commit does not have", async () => {
      const r = newRepo();
      const { log, onCommand } = logged();

      expect(await blame(r, head(r), "missing.txt", { onCommand })).toBeNull();
      expect(log.some((args) => args.includes("blame"))).toBe(false);
    });
  });

  it("stops at once, with no result, when its signal aborts", async () => {
    const r = newRepo();
    const abort = new AbortController();
    abort.abort();
    const log: string[][] = [];
    const onCommand = (_c: string, args: string[]) => log.push(args);

    expect(await blame(r, head(r), "f", { signal: abort.signal, onCommand })).toBeNull();
    expect(log).toEqual([]);
  });
});
