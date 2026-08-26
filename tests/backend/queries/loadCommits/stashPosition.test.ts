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
 * comparing those dates.
 *
 * Those dates are all *days* ago, never years, and that is load-bearing. A
 * stash lives in the `refs/stash` reflog, whose entries carry the committer
 * date they were written with; a year-2001 entry is older than every reflog
 * expiry default (`gc.reflogExpire` 90 days, `gc.reflogExpireUnreachable` 30),
 * so a single `git gc` — auto-triggered, or from ambient config this suite does
 * not control — silently drops the stash. `loadStashes` catches everything and
 * returns `[]`, so the loss would surface here as "the stash is in the wrong
 * row" rather than "there is no stash". `hardenAgainstGc` pins the config too,
 * and `assertStashListed` fails loudly if it ever happens anyway.
 */

/** An ISO-8601 instant `days` ago, in a form git parses. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Stop anything from expiring this repo's stash reflog. Nothing here should
 * trigger a gc, but the defaults that decide are read from the machine's own
 * git config, and a pruned stash is invisible to `git stash list`.
 */
function hardenAgainstGc(repo: string) {
  for (const [key, value] of [
    ["gc.auto", "0"],
    ["gc.reflogExpire", "never"],
    ["gc.reflogExpireUnreachable", "never"],
    ["maintenance.auto", "false"]
  ]) {
    cp.execFileSync("git", ["config", key, value], { cwd: repo, stdio: "pipe" });
  }
}

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

/**
 * Fail the fixture, not the assertions, if git no longer lists the stash. Every
 * test below reads "the stash is not where I expected" as a placement bug; this
 * is what separates that from "there is no stash to place".
 */
function assertStashListed(repo: string, hash: string, label: string) {
  const listed = cp.execFileSync("git", ["stash", "list", "--format=%H"], { cwd: repo }).toString();
  if (!listed.includes(hash)) {
    throw new Error(
      `fixture ${label}: git no longer lists stash ${hash} (reflog pruned?). ` +
        `\`git stash list\` returned: ${JSON.stringify(listed)}`
    );
  }
}

function load(repo: string, maxCommits: number) {
  return loadCommits(simpleGit(repo), {
    branchNames: [""],
    maxCommits,
    showRemoteBranches: false,
    dateType: "Author Date",
    showUncommittedChanges: false,
    commitOrder: "date",
    onlyFollowFirstParent: false,
    showCommitsOnlyReferencedByTags: true,
    showRemoteHeads: true,
    includeCommitsMentionedByReflogs: false,
    showSignatureStatus: false,
    showStashes: true,
    useMailmap: false,
    hiddenRemotes: []
  });
}

// A stash older than any window a small opening page would reach: it sits on a
// commit from 20 days ago, three much newer commits later.
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
  hardenAgainstGc(oldStashRepo);
  redateRoot(oldStashRepo, daysAgo(25));
  oldBaseHash = commitAt(oldStashRepo, "old-base", daysAgo(20), "a.txt");
  oldStashHash = stashAt(oldStashRepo, "old WIP", daysAgo(18), "a.txt");
  commitAt(oldStashRepo, "recent-1", daysAgo(3), "r1.txt");
  commitAt(oldStashRepo, "recent-2", daysAgo(2), "r2.txt");
  commitAt(oldStashRepo, "recent-3", daysAgo(1), "r3.txt");
  assertStashListed(oldStashRepo, oldStashHash, "oldStashRepo");

  midStashRepo = makeRepo();
  hardenAgainstGc(midStashRepo);
  redateRoot(midStashRepo, daysAgo(30));
  commitAt(midStashRepo, "c1", daysAgo(25), "c1.txt");
  midBaseHash = commitAt(midStashRepo, "c2", daysAgo(20), "c2.txt");
  midStashHash = stashAt(midStashRepo, "mid WIP", daysAgo(18), "c2.txt");
  midNewerHash = commitAt(midStashRepo, "c3", daysAgo(15), "c3.txt");
  commitAt(midStashRepo, "c4", daysAgo(10), "c4.txt");
  commitAt(midStashRepo, "c5", daysAgo(5), "c5.txt");
  assertStashListed(midStashRepo, midStashHash, "midStashRepo");

  orphanStashRepo = makeRepo();
  hardenAgainstGc(orphanStashRepo);
  // The root is newer than the stash, so no loaded commit can ever place it.
  redateRoot(orphanStashRepo, daysAgo(12));
  commitAt(orphanStashRepo, "gone", daysAgo(20), "g.txt");
  orphanStashHash = stashAt(orphanStashRepo, "orphan WIP", daysAgo(18), "g.txt");
  // Reset past the base commit, so nothing but the stash itself reaches it.
  cp.execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: orphanStashRepo, stdio: "pipe" });
  commitAt(orphanStashRepo, "later-1", daysAgo(2), "l1.txt");
  commitAt(orphanStashRepo, "later-2", daysAgo(1), "l2.txt");
  assertStashListed(orphanStashRepo, orphanStashHash, "orphanStashRepo");
});

afterAll(() => {
  rmrf(oldStashRepo);
  rmrf(midStashRepo);
  rmrf(orphanStashRepo);
});

describe("loadCommits stash placement", () => {
  it("does not pin a stash older than the whole window to the bottom of the table", async () => {
    // Window of 2 reaches only the newest commits, so nothing loaded is older
    // than the stash and its base is far out of reach.
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

  it("only ever appends rows below the ones a smaller window already had", async () => {
    // The property ADR-0019 says stashes broke: growing the window must not
    // disturb what is already drawn. A stash arriving with a later page lands
    // among the rows that page adds, never above them.
    const windows = await Promise.all([2, 3, 4, 5, 6].map((n) => load(oldStashRepo, n)));
    for (let i = 1; i < windows.length; i++) {
      const smaller = windows[i - 1].commits.map((c) => c.hash);
      const larger = windows[i].commits.map((c) => c.hash);
      expect(larger.slice(0, smaller.length)).toEqual(smaller);
    }
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
    // Split deliberately: the first says the stash reached loadCommits at all,
    // the second says where it was put.
    expect(whole.commits.some((c) => c.hash === orphanStashHash)).toBe(true);
    expect(whole.commits.at(-1)!.hash).toBe(orphanStashHash);
    expect(whole.commits.at(-1)!.refs.some((r) => r.type === "stash")).toBe(true);
  });

  it("places an ordinary stash at its date position, above its base commit", async () => {
    const result = await load(midStashRepo, 300);
    expect(result.commits.some((c) => c.hash === midStashHash)).toBe(true);
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
