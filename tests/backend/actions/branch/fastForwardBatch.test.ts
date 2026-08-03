import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fastForwardBranches } from "@/backend/actions/branch";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
});

afterAll(() => {
  rmrf(repo);
});

const tipOf = (branch: string) =>
  cp.execFileSync("git", ["rev-parse", branch], { cwd: repo }).toString().trim();

describe("fastForwardBranches", () => {
  it("advances every branch with an upstream and reports the ones without", async () => {
    // Two branches pinned at the current tip, then main moves ahead of them.
    git(["branch", "behind-a"], repo);
    git(["branch", "behind-b"], repo);
    git(["branch", "orphan"], repo);
    git(["branch", "--set-upstream-to=main", "behind-a"], repo);
    git(["branch", "--set-upstream-to=main", "behind-b"], repo);
    fs.writeFileSync(path.join(repo, "h"), "z");
    git(["add", "."], repo);
    git(["commit", "-m", "ahead"], repo);

    const results = await fastForwardBranches(simpleGit(repo), {
      // `orphan` sits between the two so a failure in the middle is proven not
      // to strand the branch queued behind it.
      branchNames: ["behind-a", "orphan", "behind-b"]
    });

    expect(results.map((r) => [r.ref, r.status === null])).toEqual([
      ["behind-a", true],
      ["orphan", false],
      ["behind-b", true]
    ]);
    const main = tipOf("main");
    expect(tipOf("behind-a")).toBe(main);
    expect(tipOf("behind-b")).toBe(main);
    expect(tipOf("orphan")).not.toBe(main); // untouched, as reported
  });
});
