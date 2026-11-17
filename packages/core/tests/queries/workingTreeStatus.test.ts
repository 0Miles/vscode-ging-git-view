import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseWorkingTreeStatus,
  workingTreeStatus
} from "@ging/core/backend/queries/workingTreeStatus";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

let repo: string;

afterEach(() => {
  if (repo) rmrf(repo);
});

const write = (name: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
};

describe("workingTreeStatus", () => {
  it("reads a clean working tree on its branch", async () => {
    repo = makeRepo();

    expect(await workingTreeStatus(simpleGit(repo))).toEqual({
      branch: "main",
      staged: [],
      unstaged: [],
      conflicted: []
    });
  });

  it("splits staged from unstaged changes, a file changed on both sides in each", async () => {
    repo = makeRepo();
    write("f", "staged");
    git(["add", "f"], repo);
    write("f", "staged, then changed again");
    write("new.txt", "staged new");
    git(["add", "new.txt"], repo);
    write("dir/untracked one.txt", "untracked, in a folder, with a space");

    const status = await workingTreeStatus(simpleGit(repo));

    expect(status.staged).toEqual([
      { path: "f", change: "modified" },
      { path: "new.txt", change: "added" }
    ]);
    expect(status.unstaged).toEqual([
      { path: "f", change: "modified" },
      // Each untracked file on its own, not its folder.
      { path: "dir/untracked one.txt", change: "untracked" }
    ]);
  });

  it("reads deletions and a staged rename with where it came from", async () => {
    repo = makeRepo();
    write("g", "g");
    git(["add", "g"], repo);
    git(["commit", "-m", "g"], repo);
    git(["mv", "f", "moved"], repo);
    fs.rmSync(path.join(repo, "g"));

    const status = await workingTreeStatus(simpleGit(repo));

    expect(status.staged).toEqual([{ path: "moved", oldPath: "f", change: "renamed" }]);
    expect(status.unstaged).toEqual([{ path: "g", change: "deleted" }]);
  });

  it("lists unmerged paths apart from both lists", async () => {
    repo = makeRepo();
    git(["checkout", "-q", "-b", "side"], repo);
    write("f", "side");
    git(["commit", "-qam", "side"], repo);
    git(["checkout", "-q", "main"], repo);
    write("f", "main");
    git(["commit", "-qam", "main"], repo);
    // Stops on the conflict, exiting non-zero.
    expect(cp.spawnSync("git", ["merge", "side"], { cwd: repo }).status).not.toBe(0);

    const status = await workingTreeStatus(simpleGit(repo));

    expect(status.conflicted).toEqual([{ path: "f", change: "conflicted" }]);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
  });

  it("says no branch with HEAD detached", async () => {
    repo = makeRepo();
    git(["checkout", "-q", "--detach"], repo);

    expect((await workingTreeStatus(simpleGit(repo))).branch).toBeNull();
  });

  it("does not write the index while it reads", async () => {
    repo = makeRepo();
    // An index git would refresh — the file's stat no longer matches — were
    // the read allowed to take its optional lock.
    const index = path.join(repo, ".git", "index");
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(repo, "f"), touched, touched);
    const before = fs.statSync(index).mtimeMs;

    await workingTreeStatus(simpleGit(repo));

    expect(fs.statSync(index).mtimeMs).toBe(before);
    // The control: a plain `git status` does write it.
    git(["status"], repo);
    expect(fs.statSync(index).mtimeMs).not.toBe(before);
  });
});

describe("parseWorkingTreeStatus", () => {
  it("keeps the spaces of a path, and a rename's original path from the next record", () => {
    const out = [
      "# branch.oid 0123",
      "# branch.head feature/x",
      "1 .M N... 100644 100644 100644 aaa aaa a file with spaces.txt",
      "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
      "old name.txt",
      "? untracked file.txt",
      ""
    ].join("\0");

    expect(parseWorkingTreeStatus(out)).toEqual({
      branch: "feature/x",
      staged: [{ path: "new name.txt", oldPath: "old name.txt", change: "renamed" }],
      unstaged: [
        { path: "a file with spaces.txt", change: "modified" },
        { path: "untracked file.txt", change: "untracked" }
      ],
      conflicted: []
    });
  });
});
