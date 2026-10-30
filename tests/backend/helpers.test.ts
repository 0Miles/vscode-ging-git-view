import * as cp from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRepo, rmrf } from "@tests/backend/helpers";

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
  it("spawns git at most three times", () => {
    vi.mocked(cp.execFileSync).mockClear();
    repo = makeRepo();
    expect(vi.mocked(cp.execFileSync).mock.calls.length).toBeLessThanOrEqual(3);
  });
});
