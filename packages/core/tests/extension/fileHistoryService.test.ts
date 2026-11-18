import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFileHistoryService, fileHistoryDiff } from "@ging/core/extension/fileHistoryService";

import { git, makeRepo, makeTempDir, rev, rmrf } from "@ging/core/tests/helpers";

let repo: string;
let empty: string;

beforeAll(() => {
  repo = makeRepo(); // "init": file "f"
  for (const content of ["two", "three"]) {
    fs.writeFileSync(path.join(repo, "f"), content);
    git(["commit", "-qam", content], repo);
  }
  empty = makeTempDir("ngg-test-");
  git(["init", "-q", "--template=", "-b", "main"], empty);
});

afterAll(() => {
  rmrf(repo);
  rmrf(empty);
});

const service = (dir: string, pageSize?: number) =>
  createFileHistoryService({ git: () => simpleGit(dir), pageSize });

describe("createFileHistoryService", () => {
  it("reads from HEAD when no commit is named, and says which commit that was", async () => {
    const answer = await service(repo).load({ path: "f", start: null, offset: 0 });

    expect(answer).toMatchObject({ path: "f", start: rev(repo, "HEAD"), offset: 0, more: false });
    expect(answer.error).toBeNull();
    expect(answer.entries.map((entry) => entry.subject)).toEqual(["three", "two", "init"]);
  });

  it("reads later pages from the commit named, a page at a time", async () => {
    const start = rev(repo, "HEAD");
    const first = await service(repo, 2).load({ path: "f", start, offset: 0 });
    const second = await service(repo, 2).load({ path: "f", start, offset: 2 });

    expect(first.entries.map((entry) => entry.subject)).toEqual(["three", "two"]);
    expect(first.more).toBe(true);
    expect(second).toMatchObject({ start, offset: 2, more: false });
    expect(second.entries.map((entry) => entry.subject)).toEqual(["init"]);
  });

  it("starts from an abbreviated hash, answering it in full", async () => {
    const full = rev(repo, "HEAD~1");
    const answer = await service(repo).load({ path: "f", start: full.slice(0, 7), offset: 0 });

    expect(answer.start).toBe(full);
    expect(answer.entries.map((entry) => entry.subject)).toEqual(["two", "init"]);
  });

  it("has nothing, and no failure, in a repository with no commit yet", async () => {
    expect(await service(empty).load({ path: "f", start: null, offset: 0 })).toEqual({
      path: "f",
      start: null,
      offset: 0,
      entries: [],
      more: false,
      error: null
    });
  });

  it("says why when the commit named is not one", async () => {
    const answer = await service(repo).load({ path: "f", start: "0".repeat(40), offset: 0 });

    expect(answer.entries).toEqual([]);
    expect(answer.error).not.toBeNull();
  });

  it.each([
    ["a ref name", { path: "f", start: "main", offset: 0 }],
    ["what git would read as an option", { path: "f", start: "--output=x", offset: 0 }],
    ["no file", { path: "", start: null, offset: 0 }],
    ["a NUL in the path", { path: "f\0g", start: null, offset: 0 }],
    ["a negative offset", { path: "f", start: null, offset: -1 }],
    ["a fractional offset", { path: "f", start: null, offset: 1.5 }]
  ])("runs no git for %s", async (_, request) => {
    let ran = false;
    const answer = await createFileHistoryService({
      git: () => {
        ran = true;
        return simpleGit(repo);
      }
    }).load(request);

    expect(ran).toBe(false);
    expect(answer.entries).toEqual([]);
    expect(answer.error).not.toBeNull();
    expect(fs.existsSync(path.join(repo, "x"))).toBe(false);
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
