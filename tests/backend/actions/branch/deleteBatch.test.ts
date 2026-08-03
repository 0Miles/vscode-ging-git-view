import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteBranches, planBranchDeletion } from "@/backend/actions/branch";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
});

afterAll(() => {
  rmrf(repo);
});

const listed = (branch: string) =>
  cp.execFileSync("git", ["branch", "--list", branch], { cwd: repo }).toString().trim();

describe("deleteBranches", () => {
  it("reports one result per ref and keeps going after a failure", async () => {
    git(["branch", "b1"], repo);
    git(["branch", "b2"], repo);

    const results = await deleteBranches(simpleGit(repo), {
      refs: ["b1", "missing", "b2"],
      forceDelete: false,
      deleteOnRemotes: false
    });

    expect(results.map((r) => [r.ref, r.status === null])).toEqual([
      ["b1", true],
      ["missing", false],
      ["b2", true]
    ]);
    // The point of the batch: `missing` failing in the middle must not strand
    // the refs queued behind it.
    expect(listed("b2")).toBe("");
  });

  it("flags a not-fully-merged refusal, which the formatted status cannot express", async () => {
    git(["checkout", "-b", "unmerged"], repo);
    fs.writeFileSync(path.join(repo, "g"), "y");
    git(["add", "."], repo);
    git(["commit", "-m", "unmerged commit"], repo);
    git(["checkout", "main"], repo);

    const [result] = await deleteBranches(simpleGit(repo), {
      refs: ["unmerged"],
      forceDelete: false,
      deleteOnRemotes: false
    });

    expect(result.notFullyMerged).toBe(true);
    // Why the flag has to exist at all: `formatGitError` keeps only git's
    // `error:` line, dropping the hint that quotes `git branch -D`. Classifying
    // off the formatted status — as the single-branch path does — never matches.
    expect(result.status).not.toBeNull();
    expect(result.status).not.toContain("git branch -D");
  });

  it("force-deletes when asked, and stops flagging", async () => {
    const results = await deleteBranches(simpleGit(repo), {
      refs: ["unmerged"],
      forceDelete: true,
      deleteOnRemotes: false
    });

    expect(results).toEqual([{ ref: "unmerged", status: null, notFullyMerged: false }]);
    expect(listed("unmerged")).toBe("");
  });

  it("deletes remote-tracking refs on their remote alongside local branches", async () => {
    const localRepo = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-remote-"));
    cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
    try {
      git(["remote", "add", "origin", remote], localRepo);
      git(["push", "origin", "main"], localRepo);
      git(["branch", "local-only", "main"], localRepo);
      git(["branch", "shipped", "main"], localRepo);
      git(["push", "origin", "shipped"], localRepo);
      git(["fetch", "origin"], localRepo);
      git(["branch", "-D", "shipped"], localRepo); // keep only the remote-tracking ref

      const results = await deleteBranches(simpleGit(localRepo), {
        refs: ["local-only", "remotes/origin/shipped"],
        forceDelete: false,
        deleteOnRemotes: false
      });

      expect(results.map((r) => [r.ref, r.status])).toEqual([
        ["local-only", null],
        ["remotes/origin/shipped", null]
      ]);
      const onRemote = cp
        .execFileSync("git", ["ls-remote", "--heads", "origin", "shipped"], { cwd: localRepo })
        .toString()
        .trim();
      expect(onRemote).toBe("");
    } finally {
      rmrf(localRepo);
      rmrf(remote);
    }
  });
});

describe("deleteBranches with 'also delete on remotes'", () => {
  /** A repo wired to a bare remote, with `feature` pushed and its
   *  remote-tracking ref fetched. `unmerged` gives `feature` a commit main does
   *  not have, so a non-force delete is refused. */
  const withRemote = async (
    unmerged: boolean,
    run: (localRepo: string, onRemote: (branch: string) => string) => Promise<void>
  ) => {
    const localRepo = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-remote-"));
    cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
    try {
      git(["remote", "add", "origin", remote], localRepo);
      git(["push", "origin", "main"], localRepo);
      git(["checkout", "-b", "feature"], localRepo);
      if (unmerged) {
        fs.writeFileSync(path.join(localRepo, "u"), "u");
        git(["add", "."], localRepo);
        git(["commit", "-m", "only on feature"], localRepo);
      }
      git(["push", "origin", "feature"], localRepo);
      git(["fetch", "origin"], localRepo);
      git(["checkout", "main"], localRepo);
      await run(localRepo, (branch) =>
        cp
          .execFileSync("git", ["ls-remote", "--heads", "origin", branch], { cwd: localRepo })
          .toString()
          .trim()
      );
    } finally {
      rmrf(localRepo);
      rmrf(remote);
    }
  };

  it("reports the remote-tracking ref as done instead of pushing a second deletion", async () => {
    await withRemote(false, async (localRepo, onRemote) => {
      const results = await deleteBranches(simpleGit(localRepo), {
        refs: ["feature", "remotes/origin/feature"],
        forceDelete: false,
        deleteOnRemotes: true
      });

      // Both refs the user selected are accounted for — the de-duplicated one
      // is reported as succeeded, not dropped from the summary.
      expect(results.map((r) => [r.ref, r.status])).toEqual([
        ["feature", null],
        ["remotes/origin/feature", null]
      ]);
      expect(onRemote("feature")).toBe("");
    });
  });

  it("still deletes the remote-tracking ref when the local delete it relied on fails", async () => {
    await withRemote(true, async (localRepo, onRemote) => {
      const results = await deleteBranches(simpleGit(localRepo), {
        refs: ["feature", "remotes/origin/feature"],
        forceDelete: false,
        deleteOnRemotes: true
      });

      // Nothing covered the remote ref, so skipping it would have silently left
      // the branch on the remote the user asked to clean up.
      const byRef = new Map(results.map((r) => [r.ref, r]));
      expect(byRef.get("feature")!.notFullyMerged).toBe(true);
      expect(byRef.get("remotes/origin/feature")!.status).toBeNull();
      expect(onRemote("feature")).toBe("");
    });
  });
});

describe("planBranchDeletion", () => {
  it("routes local and remote refs to their own git operations", () => {
    expect(planBranchDeletion(["remotes/origin/gone", "feature", "remotes/upstream/x"])).toEqual({
      local: ["feature"],
      remote: ["remotes/origin/gone", "remotes/upstream/x"]
    });
  });
});
