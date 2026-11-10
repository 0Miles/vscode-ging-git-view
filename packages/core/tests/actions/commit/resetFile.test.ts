import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { resetFileToRevision } from "@ging/core/backend/actions/commit";

import { git, makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

let repo: string;

afterEach(() => {
  if (repo) rmrf(repo);
});

/** What `git <args>` prints in `repo`, untrimmed — porcelain output keeps its
 *  leading status columns. */
function gitOut(args: string[]): string {
  return cp.execFileSync("git", args, { cwd: repo }).toString();
}

describe("resetFileToRevision", () => {
  it("restores the working-tree file to its content at the commit", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "doc.txt"), "original");
    git(["add", "."], repo);
    git(["commit", "-m", "add doc"], repo);
    const commitHash = rev(repo, "HEAD");

    // Modify the working copy, then reset it back to the commit's version.
    fs.writeFileSync(path.join(repo, "doc.txt"), "modified");
    await resetFileToRevision(simpleGit(repo), { commitHash, filePath: "doc.txt" });

    expect(fs.readFileSync(path.join(repo, "doc.txt"), "utf8")).toBe("original");
  });

  it("stages the commit's content too, for a file the commit tracks", async () => {
    // Pins the ordinary reset's index behaviour: it is `git checkout <commit>
    // -- <path>`, which writes the index as well as the working tree.
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "doc.txt"), "original\n");
    git(["add", "."], repo);
    git(["commit", "-m", "add doc"], repo);
    const commitHash = rev(repo, "HEAD");
    fs.writeFileSync(path.join(repo, "doc.txt"), "changed\n");
    git(["commit", "-am", "change doc"], repo);

    await resetFileToRevision(simpleGit(repo), { commitHash, filePath: "doc.txt" });

    expect(fs.readFileSync(path.join(repo, "doc.txt"), "utf8")).toBe("original\n");
    expect(gitOut(["status", "--porcelain", "--", "doc.txt"])).toBe("M  doc.txt\n");
  });

  it("throws for a path that doesn't exist at the commit", async () => {
    repo = makeRepo();
    const commitHash = rev(repo, "HEAD");
    await expect(
      resetFileToRevision(simpleGit(repo), { commitHash, filePath: "nope.txt" })
    ).rejects.toThrow();
  });

  describe("a stash's untracked file", () => {
    /** Stash `sub/new.txt` as an untracked file in a new repo, leaving it gone
     *  from the working tree again; what a reset of its CDV row sends. */
    function stashUntrackedFile() {
      repo = makeRepo();
      fs.mkdirSync(path.join(repo, "sub"));
      fs.writeFileSync(path.join(repo, "sub", "new.txt"), "stashed content\n");
      git(["stash", "push", "--include-untracked", "-m", "wip"], repo);
      return {
        commitHash: rev(repo, "stash@{0}"),
        filePath: "sub/new.txt",
        origin: "untracked"
      } as const;
    }

    it("restores it from the stash, leaving it untracked", async () => {
      const file = stashUntrackedFile();

      await resetFileToRevision(simpleGit(repo), file);

      expect(fs.readFileSync(path.join(repo, "sub", "new.txt"), "utf8")).toBe("stashed content\n");
      expect(gitOut(["status", "--porcelain", "--untracked-files=all"])).toBe("?? sub/new.txt\n");
    });

    it("leaves a file staged under the same name staged as it was", async () => {
      const file = stashUntrackedFile();
      fs.mkdirSync(path.join(repo, "sub"));
      fs.writeFileSync(path.join(repo, "sub", "new.txt"), "staged by the user\n");
      git(["add", "sub/new.txt"], repo);

      await resetFileToRevision(simpleGit(repo), file);

      expect(fs.readFileSync(path.join(repo, "sub", "new.txt"), "utf8")).toBe("stashed content\n");
      expect(gitOut(["show", ":sub/new.txt"])).toBe("staged by the user\n");
    });
  });
});
