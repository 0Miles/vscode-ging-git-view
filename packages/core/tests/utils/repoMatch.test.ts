import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blameLocation,
  createRepoLocator,
  repoContainingPath,
  reposNotYetKnown,
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

/** A fake realpath that records its calls. `/link/app` is a second spelling
 *  of `/real/app`; anything under `/real` or `/work` is its own real path, and
 *  nothing else exists. */
function recordingRealpath() {
  const calls: string[] = [];
  const realpath = (p: string): string | null => {
    calls.push(p);
    if (p === "/link/app" || p.startsWith("/link/app/")) return "/real/app" + p.slice(9);
    if (p.startsWith("/real/") || p.startsWith("/work/")) return p;
    return null;
  };
  return { realpath, calls };
}

/** A fake realpath that knows exactly the paths in `table`. */
function realpathFrom(table: Record<string, string>): (p: string) => string | null {
  return (p) => table[p] ?? null;
}

// Every spelling of a file finds the known repository holding it: what inline
// blame and "open to the repo of the active editor" both look up (#435).
describe("createRepoLocator", () => {
  it("finds the known repo through another spelling of it, either way round", () => {
    const locate = createRepoLocator(recordingRealpath().realpath);

    expect(locate("/real/app/src/a.ts", ["/link/app"])).toEqual({
      repo: "/link/app",
      filePath: "src/a.ts"
    });
    expect(locate("/link/app/src/a.ts", ["/real/app"])).toEqual({
      repo: "/real/app",
      filePath: "src/a.ts"
    });
  });

  it("takes the path inside the repo from the real path, spelled as git spells it", () => {
    const realpath = realpathFrom({
      "/SHORT~1/SRC/A.TS": "/real/app/src/a.ts",
      "/link/app": "/real/app"
    });

    expect(createRepoLocator(realpath)("/SHORT~1/SRC/A.TS", ["/link/app"])).toEqual({
      repo: "/link/app",
      filePath: "src/a.ts"
    });
  });

  it("resolves nothing when the path already starts with a known repo", () => {
    const { realpath, calls } = recordingRealpath();
    const locate = createRepoLocator(realpath);

    expect(locate("/work/app/src/a.ts", ["/work/app"])).toEqual({
      repo: "/work/app",
      filePath: "src/a.ts"
    });
    expect(locate("/work/app", ["/work/app"])).toBeNull();
    expect(calls).toEqual([]);
  });

  it("resolves a file only on its first lookup while the known repos stay the same", () => {
    const { realpath, calls } = recordingRealpath();
    const locate = createRepoLocator(realpath);
    const known = ["/link/app", "/work/other"];

    expect(locate("/real/app/src/a.ts", known)).toEqual({ repo: "/link/app", filePath: "src/a.ts" });
    const firstLookupCalls = calls.length;
    for (let i = 0; i < 5; i++) {
      expect(locate("/real/app/src/a.ts", [...known])).toEqual({
        repo: "/link/app",
        filePath: "src/a.ts"
      });
    }

    expect(firstLookupCalls).toBeGreaterThan(0);
    expect(calls).toHaveLength(firstLookupCalls);
  });

  it("resolves a missed file only once too", () => {
    const { realpath, calls } = recordingRealpath();
    const locate = createRepoLocator(realpath);

    expect(locate("/real/elsewhere/a.ts", ["/link/app"])).toBeNull();
    const firstLookupCalls = calls.length;
    expect(locate("/real/elsewhere/a.ts", ["/link/app"])).toBeNull();

    expect(calls).toHaveLength(firstLookupCalls);
  });

  it("finds a repo added after the file was looked up and missed", () => {
    const locate = createRepoLocator(recordingRealpath().realpath);

    expect(locate("/real/app/src/a.ts", ["/work/other"])).toBeNull();
    expect(locate("/real/app/src/a.ts", ["/work/other", "/link/app"])).toEqual({
      repo: "/link/app",
      filePath: "src/a.ts"
    });
  });

  it("stops finding a repo once it is removed", () => {
    const locate = createRepoLocator(recordingRealpath().realpath);

    expect(locate("/real/app/src/a.ts", ["/link/app", "/work/other"])).not.toBeNull();
    expect(locate("/real/app/src/a.ts", ["/work/other"])).toBeNull();
  });

  it("chooses the deepest repo when nested repos are known by another spelling", () => {
    const locate = createRepoLocator(recordingRealpath().realpath);

    expect(locate("/real/app/sub/x.ts", ["/link/app", "/link/app/sub"])).toEqual({
      repo: "/link/app/sub",
      filePath: "x.ts"
    });
  });

  it("has nothing at another spelling of a repo's root itself", () => {
    expect(createRepoLocator(recordingRealpath().realpath)("/real/app", ["/link/app"])).toBeNull();
  });

  it("has nothing for a file outside every known repo, or one that cannot be resolved", () => {
    const locate = createRepoLocator(recordingRealpath().realpath);

    expect(locate("/real/elsewhere/a.ts", ["/link/app"])).toBeNull();
    expect(locate("/nowhere/a.ts", ["/link/app"])).toBeNull();
    expect(createRepoLocator(failingRealpath)("/real/app/a.ts", ["/link/app"])).toBeNull();
  });

  it("resolves a file that no longer exists through its nearest existing folder", () => {
    const realpath = realpathFrom({ "/link/app/src": "/real/app/src", "/real/app": "/real/app" });

    expect(createRepoLocator(realpath)("/link/app/src/gone.ts", ["/real/app"])).toEqual({
      repo: "/real/app",
      filePath: "src/gone.ts"
    });
  });
});

// The built-in git extension can report a repository that the workspace search
// already added under another spelling; it is not added a second time (#435).
describe("reposNotYetKnown", () => {
  it("leaves out a path that is another spelling of a known repo", () => {
    expect(reposNotYetKnown(["/link/repo"], ["/real/repo"], fakeRealpath)).toEqual([]);
  });

  it("leaves out a path known as spelled, without resolving it", () => {
    expect(reposNotYetKnown(["/real/repo"], ["/real/repo"], failingRealpath)).toEqual([]);
  });

  it("keeps a path no known repo corresponds to, even one that cannot be resolved", () => {
    expect(reposNotYetKnown(["/other", "/real/repo"], ["/real/repo"], fakeRealpath)).toEqual([
      "/other"
    ]);
    expect(reposNotYetKnown(["/missing"], [], failingRealpath)).toEqual(["/missing"]);
  });

  it("keeps only the first of two spellings of one new repo", () => {
    expect(reposNotYetKnown(["/real/repo", "/link/repo"], [], fakeRealpath)).toEqual([
      "/real/repo"
    ]);
  });
});

describe("reposNotYetKnown (real file system)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmrf(d);
  });

  function makeRepoDir(): { parent: string; repo: string } {
    const parent = makeTempDir("ging repo mirror ");
    dirs.push(parent);
    const repo = path.join(parent, "repo");
    fs.mkdirSync(repo);
    return { parent, repo };
  }

  it("does not add the git spelling of a repo known through a junction or symlink", () => {
    const { parent, repo } = makeRepoDir();
    const link = path.join(parent, "link");
    fs.symlinkSync(repo, link, "junction");

    expect(reposNotYetKnown([toRepoPath(repo)], [toRepoPath(link)])).toEqual([]);
  });

  it("does not add the git spelling of a repo known in another letter case, on Windows", (ctx) => {
    if (process.platform !== "win32") ctx.skip("paths differing in case are different paths");
    const { repo } = makeRepoDir();

    expect(reposNotYetKnown([toRepoPath(repo)], [toRepoPath(repo).toUpperCase()])).toEqual([]);
  });

  it("adds a repo that is not known under any spelling", () => {
    const { parent, repo } = makeRepoDir();
    const other = path.join(parent, "other");
    fs.mkdirSync(other);

    expect(reposNotYetKnown([toRepoPath(other)], [toRepoPath(repo)])).toEqual([
      toRepoPath(other)
    ]);
  });
});
