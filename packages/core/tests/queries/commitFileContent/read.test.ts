import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { encode } from "iconv-lite";
import { afterEach, describe, expect, it } from "vitest";

import { getCommitFileContent } from "@ging/core/backend/queries/commitFileContent";
import { commitDiffView, type DiffSide } from "@ging/core/extension/commitDiff";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

const repos: string[] = [];
function newRepo(): string {
  const r = makeRepo();
  repos.push(r);
  return r;
}
function head(repo: string): string {
  return cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

afterEach(() => {
  for (const r of repos.splice(0)) rmrf(r);
});

describe("getCommitFileContent", () => {
  it("returns a utf8 file's contents at a commit", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "f.txt"), "héllo wörld\n");
    git(["add", "."], r);
    git(["commit", "-m", "add f"], r);
    const content = await getCommitFileContent("git", r, head(r), "f.txt", "utf8");
    expect(content).toBe("héllo wörld\n");
  });

  it("reads both sides of a stash's untracked file's diff: empty, then the stashed file", async () => {
    const r = newRepo();
    fs.mkdirSync(path.join(r, "sub"));
    fs.writeFileSync(path.join(r, "sub", "untracked.txt"), "brand new untracked\n");
    git(["stash", "push", "--include-untracked", "-m", "wip"], r);
    const stash = cp.execFileSync("git", ["rev-parse", "stash@{0}"], { cwd: r }).toString().trim();

    const { left, right } = commitDiffView(
      {
        repo: r,
        commitHash: stash,
        oldFilePath: "sub/untracked.txt",
        newFilePath: "sub/untracked.txt",
        type: "A",
        origin: "untracked"
      },
      { addedIn: () => "", deletedIn: () => "" }
    );
    const read = ({ commit, filePath }: DiffSide) =>
      getCommitFileContent("git", r, commit, filePath, "utf8");
    expect(await read(left)).toBe("");
    expect(await read(right)).toBe("brand new untracked\n");
    // The stash's own tree does not have it: reading from there is what left
    // the View File at Revision document blank.
    expect(await read({ repo: r, filePath: "sub/untracked.txt", commit: stash })).toBe("");
  });

  it("decodes a file stored in a non-utf8 encoding (win1252)", async () => {
    const r = newRepo();
    const text = "café déjà\n";
    fs.writeFileSync(path.join(r, "legacy.txt"), encode(text, "win1252"));
    git(["add", "."], r);
    git(["commit", "-m", "add legacy"], r);
    const hash = head(r);

    // Decoded with the right encoding the accents come back intact...
    expect(await getCommitFileContent("git", r, hash, "legacy.txt", "win1252")).toBe(text);
    // ...whereas utf8 would mangle the high bytes (so they must differ).
    expect(await getCommitFileContent("git", r, hash, "legacy.txt", "utf8")).not.toBe(text);
  });

  it("falls back to utf8 for an unknown encoding name", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "f.txt"), "plain\n");
    git(["add", "."], r);
    git(["commit", "-m", "add f"], r);
    expect(await getCommitFileContent("git", r, head(r), "f.txt", "not-a-real-encoding")).toBe(
      "plain\n"
    );
  });

  it("returns an empty string when the path doesn't exist at the commit", async () => {
    const r = newRepo();
    const content = await getCommitFileContent("git", r, head(r), "does-not-exist.txt", "utf8");
    expect(content).toBe("");
  });

  it("returns an empty string for the parent of a root commit, which has none", async () => {
    // The left side of a diff of a root commit's file (see `commitDiffView`).
    const r = newRepo();
    expect(await getCommitFileContent("git", r, `${head(r)}^`, "f", "utf8")).toBe("");
  });
});
