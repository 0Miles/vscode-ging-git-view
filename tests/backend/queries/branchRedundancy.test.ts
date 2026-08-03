import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkBranchRedundancy } from "@/backend/queries/branchRedundancy";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;

/** Add `file` and commit it on the current branch. */
function commitFile(file: string, message: string) {
  fs.writeFileSync(path.join(repo, file), file + "\n");
  git(["add", "."], repo);
  git(["commit", "-m", message], repo);
}

/** Branch off main with a single commit, then return to main. */
function branchWith(name: string, file: string) {
  git(["checkout", "main"], repo);
  git(["checkout", "-b", name], repo);
  commitFile(file, name);
  git(["checkout", "main"], repo);
}

beforeAll(() => {
  repo = makeRepo();

  // Merged the ordinary way: main fast-forwards onto the branch tip, so the tip
  // becomes an ancestor — the case the always-on badge already covers.
  branchWith("ff-merged", "ff.txt");
  git(["merge", "--ff-only", "ff-merged"], repo);

  // Squash merge: two commits collapsed into one on main. Ancestry can't see
  // it, and neither can per-commit patch-ids.
  git(["checkout", "-b", "squashed"], repo);
  commitFile("sq1.txt", "squashed: sq1");
  commitFile("sq2.txt", "squashed: sq2");
  git(["checkout", "main"], repo);
  git(["merge", "--squash", "squashed"], repo);
  git(["commit", "-m", "squash merge"], repo);

  // Rebase merge, simulated by cherry-picking the branch's only commit. Main
  // must move on first: cherry-picking a commit whose parent is main's own tip
  // reproduces it byte for byte — same tree, message, author and (within the
  // same second) timestamps — so git hands back the identical hash and main
  // simply fast-forwards, turning every case below into a plain ancestry merge.
  branchWith("rebased", "rb.txt");
  commitFile("after-rb.txt", "main moves on");
  git(["cherry-pick", "rebased"], repo);

  // Half landed: two commits, only the first cherry-picked onto main.
  git(["checkout", "-b", "partial"], repo);
  commitFile("pa1.txt", "partial: pa1");
  commitFile("pa2.txt", "partial: pa2");
  git(["checkout", "main"], repo);
  commitFile("after-pa.txt", "main moves on");
  git(["cherry-pick", "partial~1"], repo);

  // Applied to main, then reverted: the patch-id is still in main's history,
  // but merging the branch would bring the change back.
  branchWith("reverted", "rv.txt");
  commitFile("after-rv.txt", "main moves on");
  git(["cherry-pick", "reverted"], repo);
  git(["revert", "--no-edit", "HEAD"], repo);

  // Never seen by main.
  branchWith("fresh", "fr.txt");

  // Unrelated history.
  git(["checkout", "--orphan", "lonely"], repo);
  git(["rm", "-rf", "."], repo);
  commitFile("lonely.txt", "lonely");
  git(["checkout", "main"], repo);
});

afterAll(() => {
  rmrf(repo);
});

describe("checkBranchRedundancy (real git)", () => {
  it("reports a fast-forward-merged branch as redundant", async () => {
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "ff-merged" });
    expect(r).toEqual({ kind: "redundant", defaultBranch: "main" });
  });

  it("reports a squash-merged branch as redundant", async () => {
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "squashed" });
    expect(r).toEqual({ kind: "redundant", defaultBranch: "main" });
  });

  it("reports a rebase-merged branch as redundant", async () => {
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "rebased" });
    expect(r).toEqual({ kind: "redundant", defaultBranch: "main" });
  });

  it("counts the commits still missing, and those already applied", async () => {
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "partial" });
    expect(r).toEqual({ kind: "unmerged", defaultBranch: "main", unmerged: 1, covered: 1 });
  });

  it("counts every commit as missing on a branch main has never seen", async () => {
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "fresh" });
    expect(r).toEqual({ kind: "unmerged", defaultBranch: "main", unmerged: 1, covered: 0 });
  });

  it("still reports unmerged when the applied change was reverted", async () => {
    // `git cherry` finds the patch-id in main and calls the commit covered, but
    // merging would restore the reverted file. The verdict is merge-tree's, so
    // the branch is unmerged with nothing attributable to a specific commit.
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "reverted" });
    expect(r).toEqual({ kind: "unmerged", defaultBranch: "main", unmerged: 0, covered: 1 });
  });

  it("answers tautologically on the default branch itself", async () => {
    // Deliberate: the check runs on every branch with no special cases, so the
    // default branch answers "nothing to contribute" about itself (ADR-0006).
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "main" });
    expect(r).toEqual({ kind: "redundant", defaultBranch: "main" });
  });

  it("reports no merge base for an unrelated history", async () => {
    const r = await checkBranchRedundancy(simpleGit(repo), { branch: "lonely" });
    expect(r).toEqual({ kind: "unknown", reason: "noMergeBase" });
  });

  it("reports no default branch when none can be detected", async () => {
    const lone = makeRepo();
    try {
      git(["branch", "-m", "main", "topic"], lone);
      const r = await checkBranchRedundancy(simpleGit(lone), { branch: "topic" });
      expect(r).toEqual({ kind: "unknown", reason: "noDefaultBranch" });
    } finally {
      rmrf(lone);
    }
  });
});
