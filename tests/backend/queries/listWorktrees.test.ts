import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listWorktrees, parseWorktreeList } from "@/backend/queries/listWorktrees";

import { git, makeRepo } from "@tests/backend/helpers";

// Resolve symlinks up front: on macOS `os.tmpdir()` lives under /var -> /private/var, and
// `git worktree list` reports the realpath. Comparing realpath-to-realpath avoids false misses.
let repo: string;
let featureWt: string;
let detachedWt: string;
let soloRepo: string;
let notARepo: string;

beforeAll(() => {
  repo = fs.realpathSync(makeRepo());
  featureWt = `${repo}-wt-feature`;
  detachedWt = `${repo}-wt-detached`;
  git(["worktree", "add", featureWt, "-b", "feature/x"], repo);
  git(["worktree", "add", "--detach", detachedWt], repo);
  soloRepo = fs.realpathSync(makeRepo());
  notARepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ngg-not-a-repo-")));
});

afterAll(() => {
  for (const dir of [featureWt, detachedWt, repo, soloRepo, notARepo]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("listWorktrees (real git)", () => {
  it("returns the main worktree first, with the linked worktrees following", async () => {
    const entries = await listWorktrees(simpleGit(repo));

    // The main worktree is always first; git orders the linked worktrees itself, so compare as a set.
    expect(entries[0]).toMatchObject({ path: repo, branch: "main", detached: false });
    expect(new Set(entries.map((e) => e.path))).toEqual(new Set([repo, featureWt, detachedWt]));
  });

  it("captures branch names and detached state per worktree", async () => {
    const entries = await listWorktrees(simpleGit(repo));
    const byPath = new Map(entries.map((e) => [e.path, e]));

    expect(byPath.get(featureWt)).toMatchObject({ branch: "feature/x", detached: false });
    expect(byPath.get(detachedWt)).toMatchObject({ branch: null, detached: true });
  });

  it("returns a single entry for a repo with no linked worktrees", async () => {
    const entries = await listWorktrees(simpleGit(soloRepo));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: soloRepo, branch: "main" });
  });

  it("returns [] when the command fails (directory is not a git repo)", async () => {
    expect(await listWorktrees(simpleGit(notARepo))).toEqual([]);
  });
});

describe("parseWorktreeList", () => {
  it("parses branch, detached, bare and locked flags", () => {
    const stdout =
      "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\n" +
      "worktree /repo-detached\nHEAD bbb\ndetached\n\n" +
      "worktree /repo-locked\nHEAD ccc\nbranch refs/heads/feat/y\nlocked on removable media\n\n" +
      "worktree /bare-repo\nbare\n\n";

    expect(parseWorktreeList(stdout)).toEqual([
      { path: "/repo", branch: "main", detached: false, bare: false, locked: false },
      { path: "/repo-detached", branch: null, detached: true, bare: false, locked: false },
      { path: "/repo-locked", branch: "feat/y", detached: false, bare: false, locked: true },
      { path: "/bare-repo", branch: null, detached: false, bare: true, locked: false }
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n\n")).toEqual([]);
  });
});
