import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDefaultBranch } from "@/backend/queries/defaultBranch";
import { loadBranches } from "@/backend/queries/loadBranches";
import { branchKeyFromRefname } from "@/backend/utils/branchRef";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

/** Commit a file so the branch tip moves, giving `--merged` something to
 *  compare that isn't the initial commit. */
function commit(repo: string, name: string) {
  fs.writeFileSync(path.join(repo, name), name);
  git(["add", name], repo);
  git(["commit", "-m", name], repo);
}

/** A clone with `origin/HEAD` configured, one branch merged into main and one
 *  that isn't — the shape the feature actually runs against. */
let clone: string;
let upstream: string;
/** A repo with no remote at all, exercising the local fallback. */
let localOnly: string;
/** A repo whose branches are named so nothing in the primary list matches. */
let noDefault: string;
/** A clone whose default branch exists only on the remote — no local `main`. */
let remoteOnlyMain: string;

/** Every branch ref in the repo, which is what `resolveDefaultBranch` takes —
 *  deliberately not the displayed subset. */
const allRefs = async (repo: string): Promise<string[]> =>
  (await simpleGit(repo).raw(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]))
    .split("\n")
    .map((line) => branchKeyFromRefname(line.trim()))
    .filter((key): key is string => key !== null);

const load = (repo: string, showRemoteBranches: boolean) =>
  loadBranches(simpleGit(repo), {
    showRemoteBranches,
    hard: false,
    currentRepo: repo,
    gitPath: "git",
    includeMerged: true
  });

beforeAll(() => {
  upstream = makeRepo();
  commit(upstream, "base.txt");
  // A branch that gets fast-forwarded into main, and one that stays ahead.
  git(["checkout", "-b", "done"], upstream);
  commit(upstream, "done.txt");
  git(["checkout", "main"], upstream);
  git(["merge", "--no-ff", "-m", "merge done", "done"], upstream);
  git(["checkout", "-b", "wip"], upstream);
  commit(upstream, "wip.txt");
  git(["checkout", "main"], upstream);

  clone = makeRepo();
  git(["remote", "add", "origin", upstream], clone);
  git(["fetch", "origin"], clone);
  // `git clone` sets this automatically; a repo built by `remote add` + `fetch`
  // does not, so set it explicitly — this is the first link of the chain.
  git(["remote", "set-head", "origin", "main"], clone);

  localOnly = makeRepo();
  commit(localOnly, "base.txt");
  git(["checkout", "-b", "done"], localOnly);
  git(["checkout", "main"], localOnly);

  remoteOnlyMain = makeRepo();
  git(["remote", "add", "origin", upstream], remoteOnlyMain);
  git(["fetch", "origin"], remoteOnlyMain);
  git(["remote", "set-head", "origin", "main"], remoteOnlyMain);
  // Leave only a merged topic branch locally; `main` survives solely as
  // `remotes/origin/main`.
  git(["checkout", "-B", "done", "remotes/origin/done"], remoteOnlyMain);
  git(["branch", "-D", "main"], remoteOnlyMain);

  noDefault = makeRepo();
  commit(noDefault, "base.txt");
  git(["branch", "-m", "main", "topic-a"], noDefault);
  git(["branch", "topic-b"], noDefault);
});

afterAll(() => {
  rmrf(clone);
  rmrf(upstream);
  rmrf(localOnly);
  rmrf(noDefault);
  rmrf(remoteOnlyMain);
});

describe("resolveDefaultBranch", () => {
  it("follows origin/HEAD first", async () => {
    expect(await resolveDefaultBranch(simpleGit(clone), await allRefs(clone))).toBe(
      "remotes/origin/main"
    );
  });

  it("falls back to a local primary branch when the repo has no remote", async () => {
    expect(await resolveDefaultBranch(simpleGit(localOnly), await allRefs(localOnly))).toBe("main");
  });

  it("returns null when nothing in the chain matches", async () => {
    expect(await resolveDefaultBranch(simpleGit(noDefault), await allRefs(noDefault))).toBeNull();
  });
});

describe("loadBranches with includeMerged", () => {
  it("reports the merged branches against the resolved default branch", async () => {
    const result = await load(clone, true);
    expect(result.defaultBranch).toBe("remotes/origin/main");
    expect(result.mergedBranches).toContain("remotes/origin/done");
    expect(result.mergedBranches).not.toContain("remotes/origin/wip");
  });

  it("never surfaces refs/remotes/<remote>/HEAD as a phantom branch", async () => {
    // `%(refname:short)` shortens it to a bare `origin`, which would show up in
    // the branch list as a branch that doesn't exist. Keyed off the full
    // refname, it is dropped instead.
    const result = await load(clone, true);
    expect(result.mergedBranches).not.toContain("origin");
    expect(result.mergedBranches).not.toContain("remotes/origin/HEAD");
    expect(result.mergedBranches!.every((ref) => result.branches.includes(ref))).toBe(true);
  });

  it("scans only local refs when remote branches are hidden", async () => {
    const result = await load(clone, false);
    expect(result.mergedBranches!.some((ref) => ref.startsWith("remotes/"))).toBe(false);
  });

  it("still resolves a remote-only default branch when remote branches are hidden", async () => {
    // `remoteOnlyMain` has no local `main` — its default branch exists only as
    // `remotes/origin/main`. Resolving it from the *displayed* list would find
    // nothing here and silently switch the whole feature off.
    const shown = await load(remoteOnlyMain, true);
    const hidden = await load(remoteOnlyMain, false);
    expect(shown.defaultBranch).toBe("remotes/origin/main");
    expect(hidden.defaultBranch).toBe("remotes/origin/main");
    expect(hidden.mergedBranches).toContain("done");
  });

  it("returns an empty merged set when no default branch can be resolved", async () => {
    const result = await load(noDefault, true);
    expect(result.defaultBranch).toBeNull();
    expect(result.mergedBranches).toEqual([]);
  });

  it("omits both fields entirely when includeMerged isn't requested", async () => {
    const result = await loadBranches(simpleGit(clone), {
      showRemoteBranches: true,
      hard: false,
      currentRepo: clone,
      gitPath: "git"
    });
    expect(result.defaultBranch).toBeUndefined();
    expect(result.mergedBranches).toBeUndefined();
  });
});
