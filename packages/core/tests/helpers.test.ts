import * as cp from "node:child_process";
import * as fs from "node:fs";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { copyRepo, makeRepo, rmrf, toRepoPath } from "@tests/backend/helpers";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

/** Read a key from the repo's own `.git/config`. `--local` skips the GIT_CONFIG_*
 *  overrides from setup.ts, so the answer cannot come from them. */
function localConfig(repo: string, key: string): string {
  return cp
    .execFileSync("git", ["config", "--local", "--get", key], { cwd: repo, stdio: "pipe" })
    .toString()
    .trim();
}

describe("makeRepo", () => {
  let repo: string | undefined;

  afterEach(() => {
    if (repo) rmrf(repo);
    repo = undefined;
  });

  it("pins identity, signing and line endings in the repo's own config", () => {
    repo = makeRepo();
    expect(localConfig(repo, "user.email")).toBe("t@t.com");
    expect(localConfig(repo, "user.name")).toBe("T");
    expect(localConfig(repo, "commit.gpgsign")).toBe("false");
    expect(localConfig(repo, "tag.gpgsign")).toBe("false");
    expect(localConfig(repo, "core.autocrlf")).toBe("false");
    expect(localConfig(repo, "core.eol")).toBe("lf");
  });

  it("leaves one commit on main with the file f", () => {
    repo = makeRepo();
    const log = cp
      .execFileSync("git", ["log", "--format=%s", "main"], { cwd: repo, stdio: "pipe" })
      .toString()
      .trim();
    expect(log).toBe("init");
    const files = cp
      .execFileSync("git", ["ls-files"], { cwd: repo, stdio: "pipe" })
      .toString()
      .trim();
    expect(files).toBe("f");
  });

  // The spawn budget is what keeps the extension tests' setup hooks under Mocha's
  // 2000ms; see makeRepo's doc comment (#116).
  it("spawns git exactly three times", () => {
    vi.mocked(cp.execFileSync).mockClear();
    repo = makeRepo();
    expect(vi.mocked(cp.execFileSync).mock.calls.length).toBe(3);
  });
});

describe("copyRepo", () => {
  let seed: string;
  let repo: string | undefined;

  beforeAll(() => {
    seed = makeRepo();
  });

  afterAll(() => {
    rmrf(seed);
  });

  afterEach(() => {
    if (repo) rmrf(repo);
    repo = undefined;
  });

  const run = (args: string[], cwd: string) =>
    cp.execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

  it("hands back a repo of its own, at the seed's commit", () => {
    repo = copyRepo(seed);
    expect(repo).not.toBe(seed);
    expect(run(["rev-parse", "--show-toplevel"], repo)).toBe(toRepoPath(fs.realpathSync(repo)));
    expect(run(["rev-parse", "HEAD"], repo)).toBe(run(["rev-parse", "HEAD"], seed));
    expect(localConfig(repo, "user.email")).toBe("t@t.com");
  });

  // A copied file has a new mtime, so the copied index's stat data no longer
  // matches it. `git status` refreshes the index and would not notice; plumbing
  // like `git diff-files` does not refresh, and reads the file as modified.
  it("is clean even to plumbing that does not refresh the index", () => {
    repo = copyRepo(seed);
    expect(run(["diff-files"], repo)).toBe("");
  });

  it("leaves the seed alone when the copy is changed", () => {
    const before = run(["rev-parse", "HEAD"], seed);
    repo = copyRepo(seed);
    run(["commit", "--allow-empty", "-m", "only in the copy"], repo);
    expect(run(["rev-parse", "HEAD"], seed)).toBe(before);
  });

  // What the copy buys: the extension tests call it from a `setup` hook with
  // Mocha's 2000ms budget (#283).
  it("spawns git exactly once", () => {
    vi.mocked(cp.execFileSync).mockClear();
    repo = copyRepo(seed);
    expect(vi.mocked(cp.execFileSync).mock.calls.length).toBe(1);
  });
});
