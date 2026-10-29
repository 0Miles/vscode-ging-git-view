import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { moveBranch } from "@/backend/actions/branch";
import { formatGitError } from "@/backend/utils/gitError";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

// Dragging a branch label onto a commit (#208). Which git command moves it is
// the host's call, read off HEAD at the moment it runs: `reset --keep` for the
// checked-out branch, `branch -f` for any other.

let repo: string;
let base: string;
let tip: string;

const rev = (ref: string, cwd = repo) =>
  cp.execFileSync("git", ["rev-parse", ref], { cwd }).toString().trim();
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8");

beforeAll(() => {
  repo = makeRepo();
  fs.writeFileSync(path.join(repo, "other"), "o");
  git(["add", "."], repo);
  git(["commit", "-m", "base"], repo);
  base = rev("HEAD");
  fs.writeFileSync(path.join(repo, "f"), "tip");
  git(["commit", "-am", "tip"], repo);
  tip = rev("HEAD");
});

afterAll(() => {
  rmrf(repo);
});

describe("moveBranch on a branch that is not checked out", () => {
  it("points the branch at the commit and leaves HEAD and the working tree alone", async () => {
    git(["branch", "side", base], repo);

    await moveBranch(simpleGit(repo), { branchName: "side", commitHash: tip });

    expect(rev("side")).toBe(tip);
    expect(rev("HEAD")).toBe(tip);
    expect(cp.execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: repo }).toString().trim()).toBe(
      "refs/heads/main"
    );
    expect(read("f")).toBe("tip");
  });

  it("moves it backwards too, which is what `branch -f` allows and a fast-forward would not", async () => {
    await moveBranch(simpleGit(repo), { branchName: "side", commitHash: base });

    expect(rev("side")).toBe(base);
  });

  it("works from a detached HEAD, where no branch is checked out", async () => {
    git(["checkout", "--detach", tip], repo);
    try {
      await moveBranch(simpleGit(repo), { branchName: "main", commitHash: base });

      expect(rev("main")).toBe(base);
      expect(rev("HEAD")).toBe(tip);
    } finally {
      git(["branch", "-f", "main", tip], repo);
      git(["checkout", "main"], repo);
    }
  });
});

describe("moveBranch on the checked-out branch", () => {
  it("resets with --keep: the branch moves and an untouched uncommitted change survives", async () => {
    fs.writeFileSync(path.join(repo, "other"), "local edit");

    await moveBranch(simpleGit(repo), { branchName: "main", commitHash: base });

    expect(rev("HEAD")).toBe(base);
    expect(rev("main")).toBe(base);
    // The commit moved off is gone from the working tree ("x" is what
    // `makeRepo` seeds `f` with), as `branch -f` could never have done for HEAD...
    expect(read("f")).toBe("x");
    // ...and the edit survives, which `reset --hard` would have discarded.
    expect(read("other")).toBe("local edit");

    git(["checkout", "--", "other"], repo);
    git(["reset", "--keep", tip], repo);
  });

  it("refuses, leaving branch and change alone, when the move would overwrite a change", async () => {
    fs.writeFileSync(path.join(repo, "f"), "local edit");

    const error = await moveBranch(simpleGit(repo), { branchName: "main", commitHash: base }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).not.toBeNull();
    expect(rev("main")).toBe(tip);
    expect(read("f")).toBe("local edit");
    expect(formatGitError(error)).toContain("'f'");

    git(["checkout", "--", "f"], repo);
  });
});

describe("moveBranch on a branch checked out in another worktree", () => {
  let worktree: string;

  beforeAll(() => {
    worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-wt-")), "wt");
    git(["worktree", "add", "-b", "elsewhere", worktree, tip], repo);
  });

  afterAll(() => {
    git(["worktree", "remove", "--force", worktree], repo);
    rmrf(path.dirname(worktree));
  });

  it("is refused by git rather than moved under that worktree's feet", async () => {
    await expect(
      moveBranch(simpleGit(repo), { branchName: "elsewhere", commitHash: base })
    ).rejects.toThrow();

    expect(rev("elsewhere")).toBe(tip);
  });
});
