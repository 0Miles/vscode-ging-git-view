import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findGitDirs } from "@/backend/queries/gitDirs";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

const dirs: string[] = [];
function track<T extends string>(dir: T): T {
  dirs.push(dir);
  return dir;
}

/** The same directory however it is spelled (separators, 8.3 names, case). */
function real(p: string): string {
  return fs.realpathSync.native(p);
}

async function realGitDirs(repoPath: string) {
  const found = await findGitDirs({ gitPath: "git", repoPath });
  return found === null ? null : { gitDir: real(found.gitDir), commonDir: real(found.commonDir) };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

describe("findGitDirs (real git)", () => {
  it("finds a plain repository's .git as both its git dir and its common dir", async () => {
    const r = track(makeRepo());

    const found = await realGitDirs(r);

    expect(found).toEqual({
      gitDir: real(path.join(r, ".git")),
      commonDir: real(path.join(r, ".git"))
    });
  });

  // A linked worktree keeps its own HEAD under .git/worktrees/<name>, while its
  // branches (refs/heads, packed-refs) live in the main repository's .git.
  it("finds a linked worktree's own git dir, and the main repository's .git as its common dir", async () => {
    const r = track(makeRepo());
    const wt = path.join(r, "linked");
    git(["worktree", "add", "-b", "side", wt], r);

    const found = await realGitDirs(wt);

    expect(found).toEqual({
      gitDir: real(path.join(r, ".git", "worktrees", "linked")),
      commonDir: real(path.join(r, ".git"))
    });
  });

  it("finds a submodule's git dir under the superproject's .git/modules", async () => {
    const lib = track(makeRepo());
    const app = track(makeRepo());
    git(["-c", "protocol.file.allow=always", "submodule", "add", lib, "sub"], app);

    const found = await realGitDirs(path.join(app, "sub"));

    const modules = real(path.join(app, ".git", "modules", "sub"));
    expect(found).toEqual({ gitDir: modules, commonDir: modules });
  });

  it("finds nothing outside a repository", async () => {
    const plain = track(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-test-")));
    // Stop git from walking up into whatever repository holds the temp dir.
    const found = await findGitDirs({
      gitPath: "git",
      repoPath: plain,
      gitEnv: { GIT_CEILING_DIRECTORIES: path.dirname(plain) }
    });
    expect(found).toBeNull();
  });
});
