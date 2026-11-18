import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFileHistoryService,
  type FileHistoryServiceDeps,
  fileHistoryDiff
} from "@ging/core/extension/fileHistoryService";

import { git, makeRepo, makeTempDir, rev, rmrf } from "@ging/core/tests/helpers";

let repo: string;
let empty: string;

beforeAll(() => {
  repo = makeRepo(); // "init": file "f"
  for (const content of ["two", "three"]) {
    fs.writeFileSync(path.join(repo, "f"), content);
    git(["commit", "-qam", content], repo);
  }
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  git(["add", ".gitignore"], repo);
  git(["commit", "-qm", "ignore"], repo);
  fs.writeFileSync(path.join(repo, "ignored.txt"), "ignored");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked");
  empty = makeTempDir("ngg-test-");
  git(["init", "-q", "--template=", "-b", "main"], empty);
});

afterAll(() => {
  rmrf(repo);
  rmrf(empty);
});

/** A service on `dir`, and every git command it ran. */
function service(dir: string, more: Partial<FileHistoryServiceDeps> = {}) {
  const ran: string[][] = [];
  const made = createFileHistoryService({
    gitPath: () => "git",
    repo: () => dir,
    onCommand: (_, args) => ran.push(args),
    ...more
  });
  return Object.assign(made, { ran });
}

const subjects = (answer: { entries: { subject: string }[] } | null) =>
  answer?.entries.map((entry) => entry.subject);

describe("createFileHistoryService", () => {
  it("reads from HEAD when no commit is named, and says which commit that was", async () => {
    const answer = await service(repo).open({ path: "f", start: null });

    expect(answer).toMatchObject({
      path: "f",
      start: rev(repo, "HEAD"),
      first: true,
      more: false,
      error: null
    });
    expect(subjects(answer)).toEqual(["three", "two", "init"]);
  });

  it("reads the pages after the first from the same git, one log for the whole history", async () => {
    const history = service(repo, { pageSize: 2 });

    const first = await history.open({ path: "f", start: null });
    const second = await history.more();

    expect(subjects(first)).toEqual(["three", "two"]);
    expect(first?.more).toBe(true);
    expect(second).toMatchObject({ first: false, more: false, start: first?.start });
    expect(subjects(second)).toEqual(["init"]);
    expect(history.ran.filter((args) => args.includes("log"))).toHaveLength(1);
  });

  it("starts from an abbreviated hash, answering it in full", async () => {
    const full = rev(repo, "HEAD~2");
    const answer = await service(repo).open({ path: "f", start: full.slice(0, 7) });

    expect(answer?.start).toBe(full);
    expect(subjects(answer)).toEqual(["two", "init"]);
  });

  it("has nothing, and no failure, in a repository with no commit yet", async () => {
    expect(await service(empty).open({ path: "f", start: null })).toEqual({
      path: "f",
      start: null,
      first: true,
      entries: [],
      more: false,
      error: null
    });
  });

  it("says why when the commit named is not one", async () => {
    const answer = await service(repo).open({ path: "f", start: "0".repeat(40) });

    expect(answer?.entries).toEqual([]);
    expect(answer?.error).not.toBeNull();
  });

  it.each([
    ["a ref name", { path: "f", start: "main" }],
    ["what git would read as an option", { path: "f", start: "--output=x" }],
    ["no file", { path: "", start: null }],
    ["a NUL in the path", { path: "f\0g", start: null }]
  ])("runs no git for %s", async (_, request) => {
    const history = service(repo);

    const answer = await history.open(request);

    expect(history.ran).toEqual([]);
    expect(answer?.entries).toEqual([]);
    expect(answer?.error).not.toBeNull();
    expect(fs.existsSync(path.join(repo, "x"))).toBe(false);
  });

  it("answers nothing for a history opened over, nor for one closed", async () => {
    const history = service(repo, { pageSize: 1 });

    const over = history.open({ path: "f", start: null });
    const latest = history.open({ path: ".gitignore", start: null });

    expect(await over).toBeNull();
    expect(subjects(await latest)).toEqual(["ignore"]);

    await history.open({ path: "f", start: null });
    history.close();
    expect(await history.more()).toBeNull();
  });

  it("reads the history again past what it handed out, once stopped for being idle", async () => {
    const history = service(repo, { pageSize: 1, idleMs: 1 });
    const first = await history.open({ path: "f", start: null });
    // Past the idle time: git stopped.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await history.more();
    const third = await history.more();

    expect([subjects(first), subjects(second), subjects(third)]).toEqual([
      ["three"],
      ["two"],
      ["init"]
    ]);
    expect(third?.more).toBe(false);
    expect(history.ran.filter((args) => args.includes("log"))).toHaveLength(2);
  });

  it("stops git and says so when a page takes too long", async () => {
    const answer = await service(repo, { readMs: 0 }).open({ path: "f", start: null });

    expect(answer?.entries).toEqual([]);
    expect(answer?.error).toMatch(/took longer/);
  });

  it("tells a tracked file from an untracked or ignored one", async () => {
    const history = service(repo);

    expect(await history.isTracked("f")).toBe(true);
    expect(await history.isTracked("untracked.txt")).toBe(false);
    expect(await history.isTracked("ignored.txt")).toBe(false);
    expect(await history.isTracked("*")).toBe(false);
  });
});

describe("fileHistoryDiff", () => {
  const entry = {
    hash: "a".repeat(40),
    change: "M" as const,
    path: "new.txt",
    oldPath: "new.txt",
    submodule: null
  };

  it("diffs a rename's file against the old path in the commit's parent", () => {
    expect(fileHistoryDiff("/r", { ...entry, change: "R", oldPath: "old.txt" })).toEqual({
      repo: "/r",
      commitHash: "a".repeat(40),
      oldFilePath: "old.txt",
      newFilePath: "new.txt",
      type: "R"
    });
  });

  it("diffs a copy as a rename, against the file it was copied from", () => {
    expect(fileHistoryDiff("/r", { ...entry, change: "C", oldPath: "src.txt" })).toMatchObject({
      oldFilePath: "src.txt",
      type: "R"
    });
  });

  it.each(["A", "M", "D"] as const)("diffs a %s as that change", (change) => {
    expect(fileHistoryDiff("/r", { ...entry, change })).toMatchObject({ type: change });
  });

  it("has no diff for a submodule's entry", () => {
    expect(fileHistoryDiff("/r", { ...entry, submodule: { from: null, to: "b".repeat(40) } })).toBe(
      null
    );
  });
});
