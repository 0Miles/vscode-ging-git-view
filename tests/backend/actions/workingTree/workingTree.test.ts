import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { cleanUntrackedFiles, resetUncommittedChanges } from "@/backend/actions/workingTree";

import { makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("working tree actions", () => {
  it("resets uncommitted changes to tracked files", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");

    await resetUncommittedChanges(simpleGit(repo));

    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("x"); // reverted to HEAD
  });

  it("leaves untracked files untouched when resetting tracked changes", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "untracked"), "new");

    await resetUncommittedChanges(simpleGit(repo));

    expect(fs.existsSync(path.join(repo, "untracked"))).toBe(true); // reset --hard keeps untracked
  });

  it("cleans untracked files and directories", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "untracked"), "new");
    fs.mkdirSync(path.join(repo, "dir"));
    fs.writeFileSync(path.join(repo, "dir", "nested"), "new");

    await cleanUntrackedFiles(simpleGit(repo));

    expect(fs.existsSync(path.join(repo, "untracked"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "dir"))).toBe(false);
  });

  it("leaves tracked files untouched when cleaning untracked files", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.writeFileSync(path.join(repo, "untracked"), "new");

    await cleanUntrackedFiles(simpleGit(repo));

    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("changed"); // tracked change kept
    expect(fs.existsSync(path.join(repo, "untracked"))).toBe(false);
  });
});
