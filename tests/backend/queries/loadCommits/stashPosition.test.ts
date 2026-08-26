import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadCommits } from "@/backend/queries/loadCommits";

import { makeRepo, rmrf } from "@tests/backend/helpers";

/**
 * Where a stash's row lands, and — the point of this suite — that it does not
 * depend on how much of the history happens to be loaded.
 *
 * Every commit here is written with both its author and committer date pinned,
 * and the stash with its committer date pinned, because the row is chosen by
 * comparing those dates. Real "now" values would make the fixtures drift.
 */

function commitAt(repo: string, message: string, date: string, file: string) {
  fs.writeFileSync(path.join(repo, file), message);
  cp.execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
  cp.execFileSync("git", ["commit", "-m", message], {
    cwd: repo,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  });
  return rev(repo, "HEAD");
}

/** Stash a tracked-file change, with the stash commit's own date pinned. */
function stashAt(repo: string, message: string, date: string, file: string) {
  fs.writeFileSync(path.join(repo, file), "work in progress");
  cp.execFileSync("git", ["stash", "push", "-m", message], {
    cwd: repo,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  });
  return rev(repo, "stash@{0}");
}

function rev(repo: string, revision: string): string {
  return cp.execFileSync("git", ["rev-parse", revision], { cwd: repo }).toString().trim();
}

/** Re-date the repo's root commit, which `makeRepo` writes at the current time. */
function redateRoot(repo: string, date: string) {
  cp.execFileSync("git", ["commit", "--amend", "--no-edit", `--date=${date}`], {
    cwd: repo,
    stdio: "pipe",
    env: { ...process.env, GIT_COMMITTER_DATE: date }
  });
}

function load(repo: string, maxCommits: number) {
  return loadCommits(simpleGit(repo), {
    branchNames: [""],
    maxCommits,
    showRemoteBranches: false,
    hard: false,
    dateType: "Author Date",
    showUncommittedChanges: false,
    commitOrder: "date",
    onlyFollowFirstParent: false,
    showUntrackedFiles: true,
    showCommitsOnlyReferencedByTags: true,
    showRemoteHeads: true,
    includeCommitsMentionedByReflogs: false,
    showSignatureStatus: false,
    showStashes: true,
    useMailmap: false,
    hiddenRemotes: []
  });
}

// A stash older than any window a user is likely to open: it sits on a 2001
// commit, three 2020s commits later.
let oldStashRepo: string;
let oldStashHash: string;
let oldBaseHash: string;

// A stash in the middle of the history — the ordinary case, which must keep
// landing at its date position.
let midStashRepo: string;
let midStashHash: string;
let midBaseHash: string;
let midNewerHash: string;

// A stash whose base commit no branch reaches, so it never joins the loaded
// commits however far the window is opened.
let orphanStashRepo: string;
let orphanStashHash: string;

beforeAll(() => {
  oldStashRepo = makeRepo();
  redateRoot(oldStashRepo, "2000-01-01T00:00:00");
  oldBaseHash = commitAt(oldStashRepo, "old-base", "2001-01-01T00:00:00", "a.txt");
  oldStashHash = stashAt(oldStashRepo, "old WIP", "2001-06-01T00:00:00", "a.txt");
  commitAt(oldStashRepo, "recent-1", "2020-01-01T00:00:00", "r1.txt");
  commitAt(oldStashRepo, "recent-2", "2021-01-01T00:00:00", "r2.txt");
  commitAt(oldStashRepo, "recent-3", "2022-01-01T00:00:00", "r3.txt");

  midStashRepo = makeRepo();
  redateRoot(midStashRepo, "2000-01-01T00:00:00");
  commitAt(midStashRepo, "c1", "2001-01-01T00:00:00", "c1.txt");
  midBaseHash = commitAt(midStashRepo, "c2", "2002-01-01T00:00:00", "c2.txt");
  midStashHash = stashAt(midStashRepo, "mid WIP", "2002-06-01T00:00:00", "c2.txt");
  midNewerHash = commitAt(midStashRepo, "c3", "2003-01-01T00:00:00", "c3.txt");
  commitAt(midStashRepo, "c4", "2004-01-01T00:00:00", "c4.txt");
  commitAt(midStashRepo, "c5", "2005-01-01T00:00:00", "c5.txt");

  orphanStashRepo = makeRepo();
  redateRoot(orphanStashRepo, "2022-01-01T00:00:00");
  commitAt(orphanStashRepo, "gone", "2001-01-01T00:00:00", "g.txt");
  orphanStashHash = stashAt(orphanStashRepo, "orphan WIP", "2001-06-01T00:00:00", "g.txt");
  // Reset past the base commit, so nothing but the stash itself reaches it.
  cp.execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: orphanStashRepo, stdio: "pipe" });
  commitAt(orphanStashRepo, "later-1", "2023-01-01T00:00:00", "l1.txt");
  commitAt(orphanStashRepo, "later-2", "2024-01-01T00:00:00", "l2.txt");
});

afterAll(() => {
  rmrf(oldStashRepo);
  rmrf(midStashRepo);
  rmrf(orphanStashRepo);
});

describe("loadCommits stash placement", () => {
  it("does not pin a stash older than the whole window to the bottom of the table", async () => {
    // Window of 2 reaches only the 2020s commits, so nothing loaded is older
    // than the 2001 stash and its base is far out of reach.
    const result = await load(oldStashRepo, 2);
    expect(result.moreCommitsAvailable).toBe(true);
    expect(result.commits.at(-1)!.hash).not.toBe(oldStashHash);
  });

  it("keeps the stash on the same row as the loaded window grows", async () => {
    const windows = await Promise.all([2, 3, 4, 5, 6].map((n) => load(oldStashRepo, n)));
    const rows: number[] = [];
    for (const result of windows) {
      const idx = result.commits.findIndex((c) => c.hash === oldStashHash);
      if (idx === -1) continue;
      rows.push(idx);
      // Its base commit is the row directly below it, whatever the window size.
      expect(result.commits[idx + 1]?.hash).toBe(oldBaseHash);
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows).size).toBe(1);
  });

  it("shows the stash once the window reaches the commits it belongs among", async () => {
    const result = await load(oldStashRepo, 6);
    expect(result.moreCommitsAvailable).toBe(false);
    const stashNode = result.commits.find((c) => c.hash === oldStashHash);
    expect(stashNode).toBeDefined();
    expect(stashNode!.refs).toContainEqual({
      hash: oldStashHash,
      name: "stash@{0}",
      type: "stash"
    });
  });

  it("shows a stash the window can never place once the whole history is loaded", async () => {
    // Its base is unreachable and every loaded commit is newer, so there is no
    // row to insert it at. The end of the list is only a real row once the list
    // is the whole history — until then the stash waits.
    const truncated = await load(orphanStashRepo, 2);
    expect(truncated.moreCommitsAvailable).toBe(true);
    expect(truncated.commits.some((c) => c.hash === orphanStashHash)).toBe(false);

    const whole = await load(orphanStashRepo, 300);
    expect(whole.moreCommitsAvailable).toBe(false);
    expect(whole.commits.at(-1)!.hash).toBe(orphanStashHash);
    expect(whole.commits.at(-1)!.refs.some((r) => r.type === "stash")).toBe(true);
  });

  it("places an ordinary stash at its date position, above its base commit", async () => {
    const result = await load(midStashRepo, 300);
    const stashIdx = result.commits.findIndex((c) => c.hash === midStashHash);
    expect(stashIdx).toBeGreaterThan(0);
    // Directly between the commit that follows it in time and its own base.
    expect(result.commits[stashIdx - 1].hash).toBe(midNewerHash);
    expect(result.commits[stashIdx + 1].hash).toBe(midBaseHash);
    expect(result.commits[stashIdx].parentHashes).toEqual([midBaseHash]);
    expect(result.commits[stashIdx].refs.some((r) => r.type === "stash")).toBe(true);
  });

  it("keeps an ordinary stash's row and label unchanged as the window grows", async () => {
    const windows = await Promise.all([4, 5, 6, 300].map((n) => load(midStashRepo, n)));
    for (const result of windows) {
      const stashIdx = result.commits.findIndex((c) => c.hash === midStashHash);
      expect(stashIdx).toBe(3);
      expect(result.commits[stashIdx].refs.some((r) => r.type === "stash")).toBe(true);
      // The graph layout walk assumes parents sit at a higher index; a stash
      // whose only parent points upward hangs it.
      expect(result.commits[stashIdx + 1].hash).toBe(midBaseHash);
    }
  });
});
