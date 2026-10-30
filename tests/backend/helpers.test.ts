import * as cp from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRepo, rmrf } from "@tests/backend/helpers";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

/** Read a key from the repo's own `.git/config` only. The GIT_CONFIG_* overrides
 *  from setup.ts are dropped, so the answer cannot come from them. */
function localConfig(repo: string, key: string): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG_"))
  );
  return cp
    .execFileSync("git", ["config", "--local", "--get", key], { cwd: repo, env, stdio: "pipe" })
    .toString()
    .trim();
}

describe("makeRepo", () => {
  let repo: string | undefined;

  afterEach(() => {
    if (repo) rmrf(repo);
    repo = undefined;
    vi.mocked(cp.execFileSync).mockClear();
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

  // Every git spawn costs 100–250ms inside the VS Code extension host on Windows,
  // and the extension tests call makeRepo() from a `setup` hook with Mocha's
  // 2000ms budget. Nine spawns went over it under load (#116).
  it("spawns git at most three times", () => {
    vi.mocked(cp.execFileSync).mockClear();
    repo = makeRepo();
    expect(vi.mocked(cp.execFileSync).mock.calls.length).toBeLessThanOrEqual(3);
  });
});
