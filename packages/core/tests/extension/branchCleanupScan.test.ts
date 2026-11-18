import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBranchCleanup } from "@ging/core/extension/branchCleanupService";
import {
  type BranchFactsDeps,
  createBranchFacts,
  createGitSnapshotReader
} from "@ging/core/extension/branchFacts";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

// The deep check (#475): one read of the branch facts serves the payload
// before the scan and the one after it. Read again, they came from git a second
// time whenever the scan outlasted the facts' coalescing window (1s), which it
// does on any repository with a few branches.

let repo: string;

beforeAll(() => {
  repo = makeRepo();
  for (const branch of ["wip", "other"]) {
    git(["checkout", "-q", "-b", branch, "main"], repo);
    fs.writeFileSync(path.join(repo, branch), branch);
    git(["add", branch], repo);
    git(["commit", "-qm", branch], repo);
  }
  git(["checkout", "-q", "main"], repo);
});

afterAll(() => rmrf(repo));

describe("the branch cleanup scan", () => {
  it("reads the branch facts once, however long the scan takes", async () => {
    const reader = createGitSnapshotReader({
      gitClientFor: (r: string) => simpleGit(r),
      gitPath: () => "git"
    });
    let reads = 0;
    // Every look at the clock is ten seconds on: past the window each time.
    let now = 0;
    const deps: BranchFactsDeps = {
      readSnapshot: (r, showRemote) => {
        reads++;
        return reader(r, showRemote);
      },
      filterStore: { has: () => false, get: () => [], set: () => true },
      resolveShowRemote: () => false,
      resolveExemptPatterns: () => [],
      resolveInactiveThresholdDays: () => 0,
      resolveShowSpecificBranches: () => [],
      resolveShowCurrentBranchByDefault: () => false,
      nowMs: () => (now += 10_000)
    };
    const cleanup = createBranchCleanup({
      branchFacts: createBranchFacts(deps),
      gitClientFor: (r) => simpleGit(r),
      resolveShowRemote: () => false,
      resolveExemptPatterns: () => [],
      dateType: () => "Author Date"
    });

    const { payload, cancelled } = await cleanup.scan(repo, {
      isCancelled: () => false,
      onProgress: () => {}
    });

    expect(cancelled).toBe(false);
    expect(payload.defaultBranch).toBe("main");
    expect(payload.scannable).toBeGreaterThan(0);
    expect(reads).toBe(1);
  });
});
