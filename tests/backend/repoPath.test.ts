import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { isUsableRepoPath, pickBootRepo, resolveCurrentRepo } from "@/backend/utils/repoPath";

import { makeRepo, rmrf } from "@tests/backend/helpers";

// Real directories, no stubs: what has to hold is that this predicate answers
// the same question simple-git's constructor asks, and only the file system can
// say that. `gitClient.test.ts` pins the other half — that the constructor does
// throw on exactly these inputs.
describe("isUsableRepoPath (real fs)", () => {
  it("accepts a directory that is there", () => {
    const repo = makeRepo();
    try {
      expect(isUsableRepoPath(repo)).toBe(true);
    } finally {
      rmrf(repo);
    }
  });

  it("rejects a directory that has been removed", () => {
    const dead = makeRepo();
    rmrf(dead);
    expect(isUsableRepoPath(dead)).toBe(false);
  });

  it("rejects a path that names a file", () => {
    // Not the same branch as the one above: `fs.stat` succeeds here. simple-git
    // asks for a FOLDER, so this still throws at construction — which is why the
    // predicate is `isDirectory`, not "exists".
    const repo = makeRepo();
    try {
      expect(isUsableRepoPath(path.join(repo, "f"))).toBe(false);
    } finally {
      rmrf(repo);
    }
  });
});

describe("resolveCurrentRepo", () => {
  it("resolves nothing when no repo was ever persisted", () => {
    expect(resolveCurrentRepo(null, () => true)).toBeNull();
  });

  it("resolves nothing for the empty string", () => {
    // Not the same as "no repo": handed to simple-git it falls back to the
    // host process's cwd, which is some directory nobody chose.
    expect(resolveCurrentRepo("", () => true)).toBeNull();
  });

  it("resolves a path that is still usable", () => {
    expect(resolveCurrentRepo("/repo", () => true)).toBe("/repo");
  });

  it("resolves nothing when the path is no longer usable", () => {
    expect(resolveCurrentRepo("/repo", () => false)).toBeNull();
  });
});

describe("pickBootRepo", () => {
  it("keeps the Current repository when it resolved", () => {
    const probed: string[] = [];
    expect(
      pickBootRepo("/a", ["/b", "/c"], (p) => {
        probed.push(p);
        return true;
      })
    ).toBe("/a");
    // Costs nothing when the Current repository is already good.
    expect(probed).toEqual([]);
  });

  it("falls back to the first known repository that is still there", () => {
    expect(pickBootRepo(null, ["/dead", "/live"], (p) => p === "/live")).toBe("/live");
  });

  it("stops probing at the first usable one", () => {
    const probed: string[] = [];
    pickBootRepo(null, ["/a", "/b", "/c"], (p) => {
      probed.push(p);
      return true;
    });
    // One stat in the ordinary case, not one per known repository.
    expect(probed).toEqual(["/a"]);
  });

  it("resolves nothing when every known repository is gone", () => {
    // The webview used to take `repoPaths[0]` here, which is exactly the ghost.
    expect(pickBootRepo(null, ["/dead", "/also-dead"], () => false)).toBeNull();
  });

  it("resolves nothing when there are no known repositories at all", () => {
    expect(pickBootRepo(null, [], () => true)).toBeNull();
  });
});
