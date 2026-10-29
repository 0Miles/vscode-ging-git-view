import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetToCommit } from "@/backend/actions/commit";
import { formatGitError } from "@/backend/utils/gitError";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;
let firstHash: string;

beforeAll(() => {
  repo = makeRepo();
  firstHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  fs.writeFileSync(path.join(repo, "f"), "y");
  git(["add", "."], repo);
  git(["commit", "-m", "second"], repo);
});

afterAll(() => {
  rmrf(repo);
});

describe("resetToCommit", () => {
  it("soft-resets to a previous commit", async () => {
    await resetToCommit(simpleGit(repo), {
      commitHash: firstHash,
      resetMode: "soft"
    });

    const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    expect(head).toBe(firstHash);

    git(["commit", "-m", "second"], repo);
  });

  it("mixed-resets to a previous commit", async () => {
    await resetToCommit(simpleGit(repo), {
      commitHash: firstHash,
      resetMode: "mixed"
    });

    const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    expect(head).toBe(firstHash);

    git(["add", "."], repo);
    git(["commit", "-m", "second"], repo);
  });

  it("hard-resets to a previous commit", async () => {
    await resetToCommit(simpleGit(repo), {
      commitHash: firstHash,
      resetMode: "hard"
    });

    const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    expect(head).toBe(firstHash);
  });

  it("throws for an invalid commit hash", async () => {
    await expect(
      resetToCommit(simpleGit(repo), {
        commitHash: "0000000000000000000000000000000000000000",
        resetMode: "hard"
      })
    ).rejects.toThrow();
  });
});

// `--keep` (#207) moves the branch the way `--hard` does, but refuses rather
// than overwrite an uncommitted change. Its own repo, so the suite above can
// leave HEAD wherever its last case put it.
describe("resetToCommit with keep", () => {
  let keepRepo: string;
  let base: string;

  const head = () =>
    cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: keepRepo }).toString().trim();
  const read = (file: string) => fs.readFileSync(path.join(keepRepo, file), "utf8");

  beforeAll(() => {
    keepRepo = makeRepo();
    fs.writeFileSync(path.join(keepRepo, "other"), "o");
    git(["add", "."], keepRepo);
    git(["commit", "-m", "base"], keepRepo);
    base = head();
  });

  afterAll(() => {
    rmrf(keepRepo);
  });

  it("moves the branch and keeps an uncommitted change the reset does not touch", async () => {
    fs.writeFileSync(path.join(keepRepo, "f"), "committed");
    git(["commit", "-am", "change f"], keepRepo);
    fs.writeFileSync(path.join(keepRepo, "other"), "local edit");

    await resetToCommit(simpleGit(keepRepo), { commitHash: base, resetMode: "keep" });

    expect(head()).toBe(base);
    // The commit being undone is gone from the working tree, as with --hard
    // ("x" is what `makeRepo` seeds `f` with)...
    expect(read("f")).toBe("x");
    // ...but the uncommitted edit survives, which --hard would have discarded.
    expect(read("other")).toBe("local edit");

    git(["checkout", "--", "other"], keepRepo);
  });

  it("refuses, leaving branch and change alone, when the reset would overwrite a change", async () => {
    fs.writeFileSync(path.join(keepRepo, "f"), "committed");
    git(["commit", "-am", "change f"], keepRepo);
    const tip = head();
    fs.writeFileSync(path.join(keepRepo, "f"), "local edit");

    const error = await resetToCommit(simpleGit(keepRepo), {
      commitHash: base,
      resetMode: "keep"
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).not.toBeNull();
    expect(head()).toBe(tip);
    expect(read("f")).toBe("local edit");
    // The dialog shows `formatGitError`'s line, so that line has to be git's
    // reason — naming the file in the way — not an empty or generic message.
    expect(formatGitError(error)).toContain("'f'");
  });
});
