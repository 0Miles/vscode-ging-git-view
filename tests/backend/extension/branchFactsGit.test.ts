import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BranchFactsDeps,
  createBranchFacts,
  createGitSnapshotReader
} from "@/extension/branchFacts";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

/** Commit a file so the branch tip moves, giving `--merged` something to
 *  compare that isn't the initial commit. */
function commit(repo: string, name: string) {
  fs.writeFileSync(path.join(repo, name), name);
  git(["add", name], repo);
  git(["commit", "-m", name], repo);
}

/** A repo with `done` merged into main, `wip` not, and `keep` merged but named
 *  so an "always show" pattern can exempt it. */
let repo: string;

/** BranchFacts over the real git reader, so the wiring between the two is under
 *  test rather than stubbed out. */
function makeFacts(over: Partial<BranchFactsDeps> = {}) {
  const filters = new Map<string, string[]>();
  return createBranchFacts({
    readSnapshot: createGitSnapshotReader({
      gitClientFor: (r: string) => simpleGit(r),
      gitPath: () => "git"
    }),
    filterStore: {
      has: (r) => filters.has(r),
      get: (r) => filters.get(r) ?? [],
      set: (r, branches) => {
        filters.set(r, [...branches]);
        return true;
      }
    },
    resolveShowRemote: () => false,
    resolveExemptPatterns: () => [],
    resolveInactiveThresholdDays: () => 0,
    resolveShowSpecificBranches: () => [],
    resolveShowCurrentBranchByDefault: () => false,
    nowMs: () => Date.now(),
    ...over
  });
}

beforeAll(() => {
  repo = makeRepo();
  // Each branch forks from main, so merging one does not drag the others in
  // with it — `wip` has to stay genuinely unmerged.
  for (const branch of ["done", "wip", "keep"]) {
    git(["checkout", "main"], repo);
    git(["checkout", "-b", branch], repo);
    commit(repo, branch);
  }
  git(["checkout", "main"], repo);
  git(["merge", "--no-ff", "-m", "merge done", "done"], repo);
  git(["merge", "--no-ff", "-m", "merge keep", "keep"], repo);
});

afterAll(() => rmrf(repo));

describe("branchFacts over a real repo", () => {
  it("classifies merged branches from one read", async () => {
    const facts = makeFacts();

    const result = await facts.facts(repo);

    expect(result.isRepo).toBe(true);
    expect(result.defaultBranch).toBe("main");
    expect([...result.merged.matched].toSorted()).toEqual(["done", "keep"]);
    expect([...result.merged.hidable].toSorted()).toEqual(["done", "keep"]);
  });

  it("carries dates in the same snapshot the graph's read produces", async () => {
    // One snapshot shape serves both surfaces: the graph's load pays for the
    // dates it does not consume so that the merged verdict comes from the very
    // same read the side-view classified inactivity against.
    const facts = makeFacts();

    const result = await facts.facts(repo);

    for (const branch of ["main", "done", "wip", "keep"]) {
      expect(result.dates[branch], `${branch} should be dated`).toBeGreaterThan(0);
    }
  });

  it("exempts a branch matching an always-show pattern, keeping it a fact", async () => {
    // The `develop` case from ADR-0003, end to end: badged on both surfaces,
    // dimmed on neither.
    const facts = makeFacts({ resolveExemptPatterns: () => ["keep"] });

    const result = await facts.facts(repo);

    expect([...result.merged.matched].toSorted()).toEqual(["done", "keep"]);
    expect([...result.merged.hidable]).toEqual(["done"]);
    expect([...result.hidable]).toEqual(["done"]);
  });

  it("classifies every branch inactive once the threshold is a day away", async () => {
    // The commits were just made, so a one-day threshold matches nothing and a
    // threshold measured against a clock two days ahead matches everything but
    // the exempt head.
    const twoDaysOn = Date.now() + 2 * 86_400 * 1000;
    const now = makeFacts({ resolveInactiveThresholdDays: () => 1 });
    const later = makeFacts({
      resolveInactiveThresholdDays: () => 1,
      nowMs: () => twoDaysOn
    });

    expect([...(await now.facts(repo)).inactive.matched]).toEqual([]);
    const aged = await later.facts(repo);
    expect([...aged.inactive.matched].toSorted()).toEqual(["done", "keep", "main", "wip"]);
    // `main` is the checked-out branch, so it is a fact but never hidable.
    expect([...aged.inactive.hidable].toSorted()).toEqual(["done", "keep", "wip"]);
  });

  it("re-reads a deleted branch away once invalidated", async () => {
    const facts = makeFacts();
    await facts.facts(repo);

    git(["branch", "-D", "keep"], repo);
    facts.invalidate();

    const result = await facts.facts(repo);
    expect(result.branches).not.toContain("keep");
  });
});
