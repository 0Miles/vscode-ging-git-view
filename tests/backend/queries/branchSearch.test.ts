import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadBranchSearchIndex } from "@/backend/queries/branchSearch";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
  git(["branch", "feature/done"], repo);

  fs.writeFileSync(path.join(repo, "f"), "second");
  git(["add", "f"], repo);
  git(["commit", "-m", "second"], repo);

  fs.writeFileSync(path.join(repo, "f"), "third");
  git(["add", "f"], repo);
  git(["commit", "-m", "third"], repo);
});

afterAll(() => rmrf(repo));

describe("loadBranchSearchIndex", () => {
  it("returns local branch heads in graph order with their zero-based depth", async () => {
    const result = await loadBranchSearchIndex(simpleGit(repo), {
      branchNames: [""],
      showRemoteBranches: false,
      commitOrder: "topo",
      onlyFollowFirstParent: false,
      hiddenRemotes: []
    });

    expect(result.branches.map(({ name, depth }) => ({ name, depth }))).toEqual([
      { name: "main", depth: 0 },
      { name: "feature/done", depth: 2 }
    ]);
  });

  it("keeps branch labels whose heads are reachable through the Branch filter", async () => {
    const filteredRepo = makeRepo();
    try {
      git(["branch", "feature/done"], filteredRepo);
      fs.writeFileSync(path.join(filteredRepo, "f"), "main work");
      git(["add", "f"], filteredRepo);
      git(["commit", "-m", "main work"], filteredRepo);

      git(["checkout", "-b", "feature/wip", "feature/done"], filteredRepo);
      fs.writeFileSync(path.join(filteredRepo, "wip"), "unfinished");
      git(["add", "wip"], filteredRepo);
      git(["commit", "-m", "unfinished"], filteredRepo);
      git(["checkout", "main"], filteredRepo);

      const result = await loadBranchSearchIndex(simpleGit(filteredRepo), {
        branchNames: ["main"],
        showRemoteBranches: false,
        commitOrder: "topo",
        onlyFollowFirstParent: false,
        hiddenRemotes: []
      });

      expect(result.branches.map(({ name }) => name)).toEqual(["main", "feature/done"]);
    } finally {
      rmrf(filteredRepo);
    }
  });

  it("includes remote display refs when remote branches are shown", async () => {
    const remote = makeRepo();
    const clone = makeRepo();
    try {
      git(["remote", "add", "origin", remote], clone);
      git(["fetch", "origin"], clone);
      git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], clone);

      const result = await loadBranchSearchIndex(simpleGit(clone), {
        branchNames: [""],
        showRemoteBranches: true,
        commitOrder: "topo",
        onlyFollowFirstParent: false,
        hiddenRemotes: []
      });

      expect(result.branches.map(({ name }) => name)).toContain("origin/main");
      expect(result.branches.map(({ ref, name }) => ({ ref, name }))).toContainEqual({
        ref: "remotes/origin/main",
        name: "origin/main"
      });
      expect(result.branches.map(({ name }) => name)).not.toContain("origin/HEAD");
    } finally {
      rmrf(clone);
      rmrf(remote);
    }
  });

  it("does not let a hidden remote affect branch depths", async () => {
    const hiddenRepo = makeRepo();
    try {
      fs.writeFileSync(path.join(hiddenRepo, "f"), "remote ahead");
      git(["add", "f"], hiddenRepo);
      git(["commit", "-m", "remote ahead"], hiddenRepo);
      git(["update-ref", "refs/remotes/origin/main", "HEAD"], hiddenRepo);
      git(["reset", "--hard", "HEAD~1"], hiddenRepo);

      const result = await loadBranchSearchIndex(simpleGit(hiddenRepo), {
        branchNames: [""],
        showRemoteBranches: true,
        commitOrder: "topo",
        onlyFollowFirstParent: false,
        hiddenRemotes: ["origin"]
      });

      expect(result.branches.map(({ name, depth }) => ({ name, depth }))).toEqual([
        { name: "main", depth: 0 }
      ]);
    } finally {
      rmrf(hiddenRepo);
    }
  });

  it("applies a glob Branch filter to visible remote branches", async () => {
    const globRepo = makeRepo();
    try {
      git(["checkout", "-b", "temporary"], globRepo);
      fs.writeFileSync(path.join(globRepo, "release"), "one");
      git(["add", "release"], globRepo);
      git(["commit", "-m", "release one"], globRepo);
      git(["update-ref", "refs/remotes/origin/release/1", "HEAD"], globRepo);
      git(["checkout", "main"], globRepo);
      git(["branch", "-D", "temporary"], globRepo);

      const result = await loadBranchSearchIndex(simpleGit(globRepo), {
        branchNames: ["glob:origin/release/*"],
        showRemoteBranches: true,
        commitOrder: "topo",
        onlyFollowFirstParent: false,
        hiddenRemotes: []
      });

      expect(result.branches.map(({ name, depth }) => ({ name, depth }))).toEqual([
        { name: "origin/release/1", depth: 0 },
        { name: "main", depth: 1 }
      ]);
    } finally {
      rmrf(globRepo);
    }
  });

  it("uses the graph's first-parent history when that view is enabled", async () => {
    const firstParentRepo = makeRepo();
    try {
      git(["checkout", "-b", "feature/side"], firstParentRepo);
      fs.writeFileSync(path.join(firstParentRepo, "side"), "side");
      git(["add", "side"], firstParentRepo);
      git(["commit", "-m", "side commit"], firstParentRepo);
      git(["checkout", "main"], firstParentRepo);
      fs.writeFileSync(path.join(firstParentRepo, "main"), "main");
      git(["add", "main"], firstParentRepo);
      git(["commit", "-m", "main commit"], firstParentRepo);
      git(["merge", "--no-ff", "feature/side", "-m", "merge side"], firstParentRepo);

      const result = await loadBranchSearchIndex(simpleGit(firstParentRepo), {
        branchNames: ["main"],
        showRemoteBranches: false,
        commitOrder: "topo",
        onlyFollowFirstParent: true,
        hiddenRemotes: []
      });

      expect(result.branches.map(({ name }) => name)).toEqual(["main"]);
    } finally {
      rmrf(firstParentRepo);
    }
  });

  it("measures branch depth in the same graph order when tag-only commits are shown", async () => {
    const taggedRepo = makeRepo();
    try {
      git(["checkout", "--detach"], taggedRepo);
      fs.writeFileSync(path.join(taggedRepo, "tagged"), "tag only");
      git(["add", "tagged"], taggedRepo);
      git(["commit", "-m", "tag only"], taggedRepo);
      git(["tag", "v1"], taggedRepo);
      git(["checkout", "main"], taggedRepo);

      const result = await loadBranchSearchIndex(simpleGit(taggedRepo), {
        branchNames: [""],
        showRemoteBranches: false,
        commitOrder: "topo",
        onlyFollowFirstParent: false,
        showCommitsOnlyReferencedByTags: true,
        hiddenRemotes: []
      });

      expect(result.branches.map(({ name, depth }) => ({ name, depth }))).toEqual([
        { name: "main", depth: 1 }
      ]);
    } finally {
      rmrf(taggedRepo);
    }
  });
});
