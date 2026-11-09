import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scanBranchRedundancy } from "@/backend/queries/scanBranchRedundancy";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;

/** Add `file` and commit it on the current branch. */
function commitFile(file: string, message: string) {
  fs.writeFileSync(path.join(repo, file), file + "\n");
  git(["add", "."], repo);
  git(["commit", "-m", message], repo);
}

beforeAll(() => {
  repo = makeRepo();

  // Squash merge: two commits collapsed into one on main. Ancestry can't see
  // it, so the always-on merged classification calls this branch unmerged —
  // this scan is the half that finds it.
  git(["checkout", "-b", "squashed"], repo);
  commitFile("sq1.txt", "squashed: sq1");
  commitFile("sq2.txt", "squashed: sq2");
  git(["checkout", "main"], repo);
  git(["merge", "--squash", "squashed"], repo);
  git(["commit", "-m", "squash merge"], repo);

  // Genuinely unfinished work: a commit main does not carry in any form.
  git(["checkout", "-b", "wip"], repo);
  commitFile("wip.txt", "wip");
  git(["checkout", "main"], repo);
});

afterAll(() => rmrf(repo));

describe("scanBranchRedundancy", () => {
  it("reports the squash-merged branch and not the one with real work left", async () => {
    const result = await scanBranchRedundancy(simpleGit(repo), {
      branches: ["squashed", "wip"]
    });
    expect(result.redundant).toEqual(["squashed"]);
    expect(result.defaultBranch).toBe("main");
    expect(result.cancelled).toBe(false);
  });

  it("stops early when cancelled, keeping the verdicts already reached", async () => {
    // A scan costs one full in-memory merge per branch, so a large repo has to
    // be interruptible. Stopping is not undoing: what was judged still stands.
    let judged = 0;
    const result = await scanBranchRedundancy(simpleGit(repo), {
      branches: ["squashed", "wip"],
      onProgress: () => judged++,
      isCancelled: () => judged > 0
    });
    expect(result.redundant).toEqual(["squashed"]);
    expect(result.cancelled).toBe(true);
    expect(judged).toBe(1);
  });

  it("reports no basis when the default branch cannot be resolved", async () => {
    // No remote and no branch named like a mainline, so the whole detection
    // chain comes up empty. Merged and redundant alike are then unanswerable —
    // the caller turns that into a stated reason, not a silently short list.
    const empty = makeRepo();
    try {
      git(["branch", "-m", "main", "wip"], empty);
      const result = await scanBranchRedundancy(simpleGit(empty), { branches: ["wip"] });
      expect(result.defaultBranch).toBeNull();
      expect(result.redundant).toEqual([]);
    } finally {
      rmrf(empty);
    }
  });

  it("resolves the basis once for the whole scan, not once per branch", async () => {
    // The reason the scan is affordable enough to offer at all. The
    // single-branch path re-detects the default branch and re-reads its tree
    // every call; across N branches that is 2N extra spawns before any merge
    // starts. Only the merge itself may scale with N.
    const real = simpleGit(repo);
    const calls: string[][] = [];
    const counting = {
      raw: (args: string[]) => {
        calls.push(args);
        return real.raw(args);
      }
    } as unknown as Parameters<typeof scanBranchRedundancy>[0];

    await scanBranchRedundancy(counting, { branches: ["squashed", "wip", "main"] });

    const of = (name: string) => calls.filter((args) => args[0] === name).length;
    expect(of("for-each-ref")).toBe(1);
    expect(
      calls.filter((args) => args[0] === "rev-parse" && args[1].endsWith("^{tree}"))
    ).toHaveLength(1);
    expect(of("merge-tree")).toBe(3);
  });
});
