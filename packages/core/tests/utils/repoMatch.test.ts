import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blameLocation,
  repoContainingPath,
  resolveToKnownRepo
} from "@ging/core/backend/utils/repoMatch";

import { makeTempDir, rmrf, toRepoPath } from "@ging/core/tests/helpers";

describe("repoContainingPath", () => {
  it("returns the repo whose root contains the file", () => {
    expect(repoContainingPath("/work/app/src/index.ts", ["/work/app", "/other"])).toBe("/work/app");
  });

  it("chooses the deepest repo when repos are nested", () => {
    expect(repoContainingPath("/work/app/sub/lib/x.ts", ["/work/app", "/work/app/sub"])).toBe(
      "/work/app/sub"
    );
  });

  it("matches the repo root path itself", () => {
    expect(repoContainingPath("/work/app", ["/work/app"])).toBe("/work/app");
  });

  it("does not match a sibling repo with a shared name prefix", () => {
    expect(repoContainingPath("/work/app2/x.ts", ["/work/app"])).toBeNull();
  });

  it("returns null when no repo contains the file", () => {
    expect(repoContainingPath("/elsewhere/x.ts", ["/work/app"])).toBeNull();
  });

  it("returns null for no repos", () => {
    expect(repoContainingPath("/work/app/x.ts", [])).toBeNull();
  });
});

// Fake realpath: /link/repo and /real/repo are the same repository.
const fakeRealpath = (p: string): string | null =>
  ({ "/link/repo": "/real/repo", "/real/repo": "/real/repo" })[p] ?? p;
const failingRealpath = (): string | null => null;

describe("resolveToKnownRepo", () => {
  it("returns the path unchanged when it is already a known repo", () => {
    expect(resolveToKnownRepo("/real/repo", ["/real/repo", "/other"], fakeRealpath)).toBe(
      "/real/repo"
    );
  });

  it("maps a symlinked path to the known repo with the same real path", () => {
    expect(resolveToKnownRepo("/link/repo", ["/real/repo"], fakeRealpath)).toBe("/real/repo");
  });

  it("returns null when no known repo shares the real path", () => {
    expect(resolveToKnownRepo("/link/repo", ["/unrelated"], fakeRealpath)).toBeNull();
  });

  it("returns null when the path cannot be resolved", () => {
    expect(resolveToKnownRepo("/missing", ["/real/repo"], failingRealpath)).toBeNull();
  });
});

/** `dir` spelled with its Windows 8.3 short names, as `cmd` expands `%~sI`. */
function shortPathOf(dir: string): string {
  return execSync(`for %I in ("${dir}") do @echo %~sI`, { shell: "cmd.exe" }).toString().trim();
}

// The real file system, through the default realpath: the spellings one
// directory can go by that only the OS can tell are the same (#413).
describe("resolveToKnownRepo (real file system)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmrf(d);
  });

  /** A repository folder under a parent whose name is too long for 8.3, so
   *  the parent has a short name wherever the volume generates them. */
  function makeLongNamedRepo(): { parent: string; repo: string } {
    const parent = makeTempDir("ging repo match long name ");
    dirs.push(parent);
    const repo = path.join(parent, "repo");
    fs.mkdirSync(repo);
    return { parent, repo };
  }

  it("maps a Windows 8.3 short path to the known repo spelled with long names", (ctx) => {
    if (process.platform !== "win32") ctx.skip("8.3 short names exist only on Windows");
    const { parent, repo } = makeLongNamedRepo();
    const shortParent = shortPathOf(parent);
    if (shortParent.toLowerCase() === parent.toLowerCase()) {
      ctx.skip("this volume generates no 8.3 short names");
    }
    const known = toRepoPath(repo);

    expect(resolveToKnownRepo(toRepoPath(path.join(shortParent, "repo")), [known])).toBe(known);
  });

  it("maps a path spelled in another letter case to the known repo, on Windows", (ctx) => {
    if (process.platform !== "win32") ctx.skip("paths differing in case are different paths");
    const { repo } = makeLongNamedRepo();
    const known = toRepoPath(repo);

    expect(resolveToKnownRepo(known.toUpperCase(), [known])).toBe(known);
  });

  it("still follows a link when the native realpath fails, as on some network drives", () => {
    const { parent, repo } = makeLongNamedRepo();
    const link = path.join(parent, "link");
    fs.symlinkSync(repo, link, "junction");
    const native = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
      throw new Error("EISDIR: illegal operation on a directory, realpath");
    });
    const known = toRepoPath(repo);

    expect(resolveToKnownRepo(toRepoPath(link), [known])).toBe(known);
    expect(native).toHaveBeenCalled();
  });

  it("matches nothing for a path that does not exist", () => {
    const { parent, repo } = makeLongNamedRepo();

    expect(
      resolveToKnownRepo(toRepoPath(path.join(parent, "gone")), [toRepoPath(repo)])
    ).toBeNull();
  });
});

// Inline blame follows the editor: the file is blamed in the known repository
// that holds it, never in whichever repository the graph shows.
describe("blameLocation", () => {
  it("blames a file in the known repository that contains it, by its repo-relative path", () => {
    expect(blameLocation("/work/app/src/index.ts", ["/other", "/work/app"])).toEqual({
      repo: "/work/app",
      filePath: "src/index.ts"
    });
  });

  it("blames a submodule or worktree file in its own repository, not the one around it", () => {
    expect(
      blameLocation("/work/app/.claude/worktrees/wt/a.ts", [
        "/work/app",
        "/work/app/.claude/worktrees/wt"
      ])
    ).toEqual({ repo: "/work/app/.claude/worktrees/wt", filePath: "a.ts" });
  });

  it("accepts a repo root written with a trailing slash", () => {
    expect(blameLocation("/work/app/a.ts", ["/work/app/"])).toEqual({
      repo: "/work/app/",
      filePath: "a.ts"
    });
  });

  it("has nothing to blame outside every known repository", () => {
    expect(blameLocation("/elsewhere/a.ts", ["/work/app"])).toBeNull();
  });

  it("has nothing to blame at a repository's root itself", () => {
    expect(blameLocation("/work/app", ["/work/app"])).toBeNull();
  });
});
