import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { isGitRepository } from "@ging/core/backend/utils/git";
import { searchDirectoryForRepos } from "@ging/core/backend/utils/repoSearch";

import { git, rmrf, toRepoPath } from "@ging/core/tests/helpers";

// The real `isGitRepository`, wrapped so a test can count how many times the
// search asks git — each call is a spawn.
vi.mock("@ging/core/backend/utils/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ging/core/backend/utils/git")>();
  return { ...actual, isGitRepository: vi.fn(actual.isGitRepository) };
});

// `searchDirectoryForRepos` is only ever handed forward-slash paths in production
// (its callers go through `getPathFromUri`) and builds child paths the same way,
// so the fixtures below use `toRepoPath` rather than raw `path.join` output.
//
// Directory layout created in beforeAll:
//   tmpDir/
//     repo-a/          ← git repo
//     not-a-repo/      ← plain directory
//     nested/
//       repo-b/        ← git repo (depth 2 from tmpDir)

let tmpDir: string;
let repoA: string;
let repoB: string;
let nonRepoDir: string;

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    git(["init", "-b", "main"], dir);
  } catch {
    git(["init"], dir);
    git(["checkout", "-b", "main"], dir);
  }
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "T"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  fs.writeFileSync(path.join(dir, "f"), "x");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

beforeAll(() => {
  tmpDir = toRepoPath(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-search-")));
  repoA = `${tmpDir}/repo-a`;
  repoB = `${tmpDir}/nested/repo-b`;
  nonRepoDir = `${tmpDir}/not-a-repo`;

  initRepo(repoA);
  initRepo(repoB);
  fs.mkdirSync(nonRepoDir);
  fs.writeFileSync(path.join(nonRepoDir, "readme.txt"), "hello");
});

afterAll(() => {
  rmrf(tmpDir);
});

describe("searchDirectoryForRepos", () => {
  it("finds a repo at the given directory (depth 0)", async () => {
    const result = await searchDirectoryForRepos(repoA, 0, "git", []);
    expect(result).toEqual([repoA]);
  });

  it("returns [] for a non-repo at depth 0", async () => {
    const result = await searchDirectoryForRepos(nonRepoDir, 0, "git", []);
    expect(result).toEqual([]);
  });

  it("returns [] for a non-existent directory", async () => {
    const result = await searchDirectoryForRepos("/tmp/ngg-does-not-exist-xyz", 0, "git", []);
    expect(result).toEqual([]);
  });

  it("skips directory already in knownRepoPaths", async () => {
    const result = await searchDirectoryForRepos(repoA, 0, "git", [repoA]);
    expect(result).toEqual([]);
  });

  it("skips subdirectory of a known repo", async () => {
    const sub = `${repoA}/src`;
    fs.mkdirSync(sub);
    try {
      const result = await searchDirectoryForRepos(sub, 0, "git", [repoA]);
      expect(result).toEqual([]);
    } finally {
      rmrf(sub);
    }
  });

  it("respects maxDepth=0: does not recurse into non-repo", async () => {
    const result = await searchDirectoryForRepos(tmpDir, 0, "git", []);
    expect(result).toEqual([]);
  });

  it("finds repos at depth 1", async () => {
    const result = await searchDirectoryForRepos(tmpDir, 1, "git", []);
    expect(result).toEqual([repoA]);
  });

  it("finds nested repos when depth allows", async () => {
    const result = await searchDirectoryForRepos(tmpDir, 2, "git", []);
    expect(result.toSorted()).toEqual([repoA, repoB].toSorted());
  });

  it("does not return .git subdirectory as a repo", async () => {
    const result = await searchDirectoryForRepos(tmpDir, 2, "git", []);
    expect(result.every((r) => !r.includes("/.git"))).toBe(true);
  });

  it("includes submodule repos declared in .gitmodules", async () => {
    const superRoot = toRepoPath(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-sub-")));
    try {
      initRepo(superRoot);
      const sub = `${superRoot}/sub`;
      initRepo(sub); // an initialised submodule (its own repo)
      fs.writeFileSync(
        path.join(superRoot, ".gitmodules"),
        '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n'
      );
      const result = await searchDirectoryForRepos(superRoot, 0, "git", []);
      expect(result).toContain(superRoot);
      expect(result).toContain(sub);
    } finally {
      rmrf(superRoot);
    }
  });

  it("ignores .gitmodules entries that are not initialised repos", async () => {
    const superRoot = toRepoPath(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-sub2-")));
    try {
      initRepo(superRoot);
      fs.mkdirSync(path.join(superRoot, "empty-sub")); // declared but not a repo
      fs.writeFileSync(
        path.join(superRoot, ".gitmodules"),
        '[submodule "empty-sub"]\n\tpath = empty-sub\n\turl = ./empty-sub\n'
      );
      const result = await searchDirectoryForRepos(superRoot, 0, "git", []);
      expect(result).toEqual([superRoot]);
    } finally {
      rmrf(superRoot);
    }
  });

  describe("asking git", () => {
    beforeEach(() => {
      vi.mocked(isGitRepository).mockClear();
    });

    it("finds the repo it starts in when it starts in a subfolder of one", async () => {
      const sub = `${repoA}/deeper/sub`;
      fs.mkdirSync(sub, { recursive: true });
      try {
        const result = await searchDirectoryForRepos(sub, 2, "git", []);
        expect(result).toEqual([sub]);
      } finally {
        rmrf(`${repoA}/deeper`);
      }
    });

    it("asks git once for the start and once per folder with a .git entry", async () => {
      // root/          (not a repo)
      //   a/ a/x/ a/x/p/   b/ b/y/   c/   — six plain folders
      //   a/r1/        repo (depth 2)
      //   b/y/r2/      repo (depth 3)
      const root = toRepoPath(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-count-")));
      try {
        for (const d of ["a/x/p", "b/y", "c"]) fs.mkdirSync(`${root}/${d}`, { recursive: true });
        initRepo(`${root}/a/r1`);
        initRepo(`${root}/b/y/r2`);
        vi.mocked(isGitRepository).mockClear();

        const result = await searchDirectoryForRepos(root, 3, "git", []);

        expect(result.toSorted()).toEqual([`${root}/a/r1`, `${root}/b/y/r2`].toSorted());
        expect(vi.mocked(isGitRepository)).toHaveBeenCalledTimes(3);
      } finally {
        rmrf(root);
      }
    });

    it("walks past a .git entry git does not recognise, and finds the repo below it", async () => {
      // root/broken/.git/   empty: not a repository
      // root/broken/inner/  repo
      const root = toRepoPath(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-broken-")));
      try {
        fs.mkdirSync(`${root}/broken/.git`, { recursive: true });
        initRepo(`${root}/broken/inner`);

        const result = await searchDirectoryForRepos(root, 2, "git", []);

        expect(result).toEqual([`${root}/broken/inner`]);
      } finally {
        rmrf(root);
      }
    });
  });
});
