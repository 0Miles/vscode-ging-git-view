import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  abortOperation,
  continueOperation,
  markResolved
} from "@ging/core/backend/actions/operation";
import { detectOperation } from "@ging/core/backend/queries/operationState";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) rmrf(dir);
});

// Mirror the extension's gitClient: GIT_EDITOR=true (so --continue never opens
// an editor) needs unsafe.allowUnsafeEditor.
const client = (repo: string) =>
  simpleGit({ baseDir: repo, unsafe: { allowUnsafeEditor: true } }).env("GIT_EDITOR", "true");

const conflictGit = (args: string[], cwd: string): void => {
  try {
    cp.execFileSync("git", args, { cwd, stdio: "pipe" });
  } catch {
    /* expected conflict */
  }
};

// main and feature both change f's only line, so rebasing one onto the other
// conflicts and pauses (leaving .git/rebase-merge).
function makeRebaseConflict(): string {
  const repo = makeRepo();
  repos.push(repo);
  fs.writeFileSync(path.join(repo, "f"), "base\n");
  git(["commit", "-am", "base"], repo);
  git(["checkout", "-b", "feature"], repo);
  fs.writeFileSync(path.join(repo, "f"), "feature\n");
  git(["commit", "-am", "feature"], repo);
  git(["checkout", "main"], repo);
  fs.writeFileSync(path.join(repo, "f"), "main\n");
  git(["commit", "-am", "main"], repo);
  git(["checkout", "feature"], repo);
  conflictGit(["rebase", "main"], repo);
  return repo;
}

describe("rebase operation actions (real git)", () => {
  it("abortOperation aborts an in-progress rebase", async () => {
    const repo = makeRebaseConflict();
    expect(await detectOperation(simpleGit(repo))).toBe("rebase");
    await abortOperation(client(repo));
    expect(await detectOperation(simpleGit(repo))).toBeNull(); // rebase-merge gone
    expect(fs.existsSync(path.join(repo, ".git", "rebase-merge"))).toBe(false);
    // Back on feature with its content restored.
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("feature\n");
  });

  it("continueOperation finishes a rebase once conflicts are resolved", async () => {
    const repo = makeRebaseConflict();
    fs.writeFileSync(path.join(repo, "f"), "resolved\n");
    git(["add", "f"], repo);
    await continueOperation(client(repo));
    expect(await detectOperation(simpleGit(repo))).toBeNull(); // rebase completed
  });
});

const out = (args: string[], cwd: string): string =>
  cp.execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

// main and side both change every name in `names` from "base", so merging side
// into main leaves each of them unmerged (stages 1, 2 and 3).
function makeMergeConflict(names: string[]): string {
  const repo = makeRepo();
  repos.push(repo);
  for (const name of names) fs.writeFileSync(path.join(repo, name), "base\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "base"], repo);
  git(["checkout", "-b", "side"], repo);
  for (const name of names) fs.writeFileSync(path.join(repo, name), "side\n");
  git(["commit", "-am", "side"], repo);
  git(["checkout", "main"], repo);
  for (const name of names) fs.writeFileSync(path.join(repo, name), "main\n");
  git(["commit", "-am", "main"], repo);
  conflictGit(["merge", "side"], repo);
  return repo;
}

/** The path of every entry `git ls-files -u` lists (one per stage). */
const unmergedEntries = (repo: string): string[] =>
  out(["ls-files", "-u", "-z"], repo)
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => line.slice(line.indexOf("\t") + 1));

describe("markResolved (real git)", () => {
  it("takes a file name with pathspec magic as written (#468)", async () => {
    const repo = makeMergeConflict(["[ab].txt", "a.txt"]);
    expect(unmergedEntries(repo).toSorted()).toEqual(
      ["[ab].txt", "[ab].txt", "[ab].txt", "a.txt", "a.txt", "a.txt"].toSorted()
    );
    fs.writeFileSync(path.join(repo, "b.txt"), "untracked\n");
    fs.writeFileSync(path.join(repo, "[ab].txt"), "resolved\n");

    await markResolved(client(repo), { filePath: "[ab].txt" });

    // Only [ab].txt is resolved; a.txt keeps all three stages.
    expect(unmergedEntries(repo)).toEqual(["a.txt", "a.txt", "a.txt"]);
    // The untracked b.txt is not staged.
    expect(out(["status", "--porcelain"], repo).split("\n")).toContain("?? b.txt");
    // [ab].txt sits at stage 0 with exactly the working tree's content.
    expect(out(["ls-files", "-s", "--", ":(literal)[ab].txt"], repo)).toMatch(/ 0\t\[ab\]\.txt\n$/);
    expect(out(["diff", "--", ":(literal)[ab].txt"], repo)).toBe("");
  });

  it("resolves a plain file name", async () => {
    const repo = makeMergeConflict(["a.txt"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "resolved\n");

    await markResolved(client(repo), { filePath: "a.txt" });

    expect(unmergedEntries(repo)).toEqual([]);
  });

  it("records the deletion when the user removed the conflicted file", async () => {
    // modify/delete: side deletes gone.txt, main modifies it.
    const repo = makeRepo();
    repos.push(repo);
    fs.writeFileSync(path.join(repo, "gone.txt"), "base\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "side"], repo);
    git(["rm", "gone.txt"], repo);
    git(["commit", "-m", "side"], repo);
    git(["checkout", "main"], repo);
    fs.writeFileSync(path.join(repo, "gone.txt"), "main\n");
    git(["commit", "-am", "main"], repo);
    conflictGit(["merge", "side"], repo);
    expect(unmergedEntries(repo)).toContain("gone.txt");
    fs.rmSync(path.join(repo, "gone.txt"));

    await markResolved(client(repo), { filePath: "gone.txt" });

    expect(unmergedEntries(repo)).toEqual([]);
    expect(out(["ls-files"], repo).split("\n")).not.toContain("gone.txt");
  });
});
