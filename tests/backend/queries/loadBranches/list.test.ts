import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gitClientFactory } from "@/backend/gitClient";
import { loadBranches } from "@/backend/queries/loadBranches";

import { git, makeRepo } from "@tests/backend/helpers";

let simpleRepo: string;
let detachedRepo: string;
let repoWithRemote: string;
let originalLang: string | undefined;

beforeAll(() => {
  originalLang = process.env["LANG"];
  process.env["LANG"] = "en_US.UTF-8";
  simpleRepo = makeRepo();
  git(["branch", "feature/foo"], simpleRepo);

  detachedRepo = makeRepo();
  const hash = cp
    .execFileSync("git", ["rev-parse", "HEAD"], { cwd: detachedRepo })
    .toString()
    .trim();
  git(["checkout", "--detach", hash], detachedRepo);

  const remoteRepo = makeRepo();
  repoWithRemote = makeRepo();
  git(["remote", "add", "origin", remoteRepo], repoWithRemote);
  git(["fetch", "origin"], repoWithRemote);
});

afterAll(() => {
  if (originalLang === undefined) {
    delete process.env["LANG"];
  } else {
    process.env["LANG"] = originalLang;
  }
  fs.rmSync(simpleRepo, { recursive: true, force: true });
  fs.rmSync(detachedRepo, { recursive: true, force: true });
  fs.rmSync(repoWithRemote, { recursive: true, force: true });
});

describe("loadBranches", () => {
  it("head branch is first in the returned array", async () => {
    const result = await loadBranches(simpleGit(simpleRepo), {
      showRemoteBranches: false,
      hard: false,
      currentRepo: simpleRepo,
      gitPath: "git"
    });
    expect(result).toEqual({
      branches: expect.any(Array),
      head: "main",
      hard: false,
      isRepo: true
    });
    expect(result.branches[0]).toBe("main");
  });

  it("non-head branches are present", async () => {
    const result = await loadBranches(simpleGit(simpleRepo), {
      showRemoteBranches: false,
      hard: false,
      currentRepo: simpleRepo,
      gitPath: "git"
    });
    expect(result.branches).toContain("feature/foo");
  });

  it("detached HEAD yields head: null with branches still listed", async () => {
    const result = await loadBranches(simpleGit(detachedRepo), {
      showRemoteBranches: false,
      hard: false,
      currentRepo: detachedRepo,
      gitPath: "git"
    });
    expect(result).toEqual({
      branches: expect.any(Array),
      head: null,
      hard: false,
      isRepo: true
    });
    expect(result.branches.length).toBeGreaterThan(0);
  });

  it("excludes remote-tracking branches when showRemoteBranches is false", async () => {
    const result = await loadBranches(simpleGit(repoWithRemote), {
      showRemoteBranches: false,
      hard: false,
      currentRepo: repoWithRemote,
      gitPath: "git"
    });
    expect(result).toEqual({
      branches: expect.any(Array),
      head: expect.any(String),
      hard: false,
      isRepo: true
    });
    expect(result.branches.some((b) => b.startsWith("remotes/"))).toBe(false);
  });

  it("includes remote-tracking branches when showRemoteBranches is true", async () => {
    const result = await loadBranches(simpleGit(repoWithRemote), {
      showRemoteBranches: true,
      hard: false,
      currentRepo: repoWithRemote,
      gitPath: "git"
    });
    expect(result).toEqual({
      branches: expect.any(Array),
      head: expect.any(String),
      hard: false,
      isRepo: true
    });
    expect(result.branches.some((b) => b.startsWith("remotes/origin/"))).toBe(true);
  });

  it("returns isRepo: false for a non-git directory", async () => {
    const result = await loadBranches(simpleGit(os.tmpdir()), {
      showRemoteBranches: false,
      hard: false,
      currentRepo: os.tmpdir(),
      gitPath: "git"
    });
    expect(result).toEqual({
      branches: [],
      head: null,
      hard: false,
      isRepo: false
    });
  });

  it("does not include shell colour codes when color.branch is always", async () => {
    const r = makeRepo();
    try {
      cp.execFileSync("git", ["config", "color.branch", "always"], { cwd: r });
      cp.execFileSync("git", ["branch", "feature"], { cwd: r });
      // The gitClient disables colour, so branch names must be free of ANSI escapes.
      const client = gitClientFactory(r, "git");
      const result = await loadBranches(client.getInstance(), {
        showRemoteBranches: false,
        hard: false,
        currentRepo: r,
        gitPath: "git"
      });
      // eslint-disable-next-line no-control-regex
      expect(result.branches.every((b) => !/\x1b\[/.test(b))).toBe(true);
      expect(result.branches).toContain("feature");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("passes hard flag through to the result", async () => {
    const result = await loadBranches(simpleGit(simpleRepo), {
      showRemoteBranches: false,
      hard: true,
      currentRepo: simpleRepo,
      gitPath: "git"
    });
    expect(result).toEqual({
      branches: expect.any(Array),
      head: expect.any(String),
      hard: true,
      isRepo: true
    });
  });

  it("omits branchDates unless includeDates is requested", async () => {
    const result = await loadBranches(simpleGit(simpleRepo), {
      showRemoteBranches: false,
      hard: false,
      currentRepo: simpleRepo,
      gitPath: "git"
    });
    expect(result.branchDates).toBeUndefined();
  });

  it("returns a last-commit time for every branch when includeDates is set", async () => {
    const result = await loadBranches(simpleGit(simpleRepo), {
      showRemoteBranches: false,
      hard: false,
      currentRepo: simpleRepo,
      gitPath: "git",
      includeDates: true
    });
    expect(result.branchDates).toBeDefined();
    for (const branch of result.branches) {
      expect(typeof result.branchDates![branch]).toBe("number");
      expect(Number.isFinite(result.branchDates![branch])).toBe(true);
    }
  });

  it("keys remote branch dates to match the remotes/ branch-list format", async () => {
    const result = await loadBranches(simpleGit(repoWithRemote), {
      showRemoteBranches: true,
      hard: false,
      currentRepo: repoWithRemote,
      gitPath: "git",
      includeDates: true
    });
    const remote = result.branches.find((b) => b.startsWith("remotes/origin/"))!;
    expect(typeof result.branchDates![remote]).toBe("number");
  });
});
