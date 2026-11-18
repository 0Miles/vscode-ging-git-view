import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { readFileDiff } from "@ging/core/backend/queries/fileHunks";
import { loadCommits } from "@ging/core/backend/queries/loadCommits";
import { operationState } from "@ging/core/backend/queries/operationState";
import { getNewPathOfRenamedFile } from "@ging/core/backend/queries/renamedFilePath";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

// #451: GING reads the repository in the background — the graph reloads on
// every watcher event, refresh and auto-fetch — while the user, or GING itself,
// writes to it. A read that takes `.git/index.lock`, however briefly, makes a
// stage, commit or graph action landing in that moment fail with
// "index.lock: File exists". The reads here go through the client both hosts
// build (`gitClientFactory`), as the graph's do.
//
// A race between a read and a write is caught only now and then (measured:
// about one write in 40 refused, with two reads looping), so these watch the
// git dir for the lock itself: no lock taken, no write refused.

let repo: string;

afterEach(() => {
  if (repo) rmrf(repo);
});

const client = () => gitClientFactory(repo, "git").getInstance();

const RELOAD: Parameters<typeof loadCommits>[1] = {
  branchNames: [""],
  maxCommits: 300,
  showRemoteBranches: false,
  dateType: "Author Date",
  showUncommittedChanges: true,
  commitOrder: "date",
  onlyFollowFirstParent: false,
  showCommitsOnlyReferencedByTags: true,
  showRemoteHeads: true,
  includeCommitsMentionedByReflogs: false,
  showSignatureStatus: false,
  showStashes: true,
  useMailmap: false,
  hiddenRemotes: []
};

/** Give `files` a timestamp the index does not have, their content unchanged:
 *  what a read allowed to refresh the index would write back. */
function makeStatDirty(...files: string[]) {
  const touched = new Date(Date.now() + 5_000);
  for (const file of files) fs.utimesSync(path.join(repo, file), touched, touched);
}

/**
 * The lock files created in the repo's git dir while `read` runs. Every event
 * the read caused is in before the watcher hears about a file written after
 * it: a watcher's events arrive in the order they happened.
 */
async function locksTakenBy<T>(read: () => Promise<T>): Promise<{ result: T; locks: string[] }> {
  const gitDir = path.join(repo, ".git");
  const sentinel = "ging-test-sentinel";
  const locks = new Set<string>();
  const watcher = fs.watch(gitDir);
  const sentinelHeard = new Promise<void>((resolve) => {
    watcher.on("change", (_event, name) => {
      const file = String(name);
      if (file.endsWith(".lock")) locks.add(file);
      if (file === sentinel) resolve();
    });
  });
  try {
    const result = await read();
    fs.writeFileSync(path.join(gitDir, sentinel), "");
    await sentinelHeard;
    return { result, locks: [...locks] };
  } finally {
    watcher.close();
    fs.rmSync(path.join(gitDir, sentinel), { force: true });
  }
}

describe("the reads the graph makes in the background", () => {
  it("reload the graph, the uncommitted changes counted, without taking the index lock", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "g"), "y");
    git(["add", "g"], repo);
    git(["commit", "-m", "g"], repo);
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["add", "f"], repo);
    makeStatDirty("g");

    const { result, locks } = await locksTakenBy(() => loadCommits(client(), RELOAD));

    expect(result.commits[0].message).toBe("Uncommitted Changes (1)");
    expect(locks).toEqual([]);
    // The control: the same status, read without the client's environment,
    // takes it — even with nothing left to refresh.
    expect((await locksTakenBy(() => simpleGit(repo).status())).locks).toEqual(["index.lock"]);
    expect((await locksTakenBy(() => simpleGit(repo).status())).locks).toEqual(["index.lock"]);
  });

  it("list a conflict's files without taking the index lock", async () => {
    repo = makeRepo();
    git(["checkout", "-q", "-b", "side"], repo);
    fs.writeFileSync(path.join(repo, "f"), "side");
    git(["commit", "-qam", "side"], repo);
    git(["checkout", "-q", "main"], repo);
    fs.writeFileSync(path.join(repo, "f"), "main");
    fs.writeFileSync(path.join(repo, "g"), "y");
    git(["add", "."], repo);
    git(["commit", "-qm", "main"], repo);
    expect(() => git(["merge", "side"], repo)).toThrow();
    makeStatDirty("g");

    const { result, locks } = await locksTakenBy(() => operationState(client()));

    expect(result).toEqual({ operation: "merge", conflictedFiles: ["f"] });
    expect(locks).toEqual([]);
    // The control: a status read the plain way takes it, in this same state,
    // so the watch does see a lock taken here. The same diff without
    // NO_INDEX_REFRESH takes it too on git 2.40.1 (Windows), and this test
    // turned red there with NO_INDEX_REFRESH emptied; git 2.56.1 (CI's ubuntu)
    // took none, so the diff cannot be the control everywhere.
    const control = await locksTakenBy(() => simpleGit(repo).status());
    expect(control.locks).toEqual(["index.lock"]);
  });

  it("find a file's new name without taking the index lock", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "g"), "y");
    git(["add", "g"], repo);
    git(["commit", "-qm", "g"], repo);
    const commit = (await simpleGit(repo).revparse(["HEAD"])).trim();
    git(["mv", "f", "moved"], repo);
    makeStatDirty("g");

    const { result, locks } = await locksTakenBy(() =>
      getNewPathOfRenamedFile(client(), commit, "f")
    );

    expect(result).toBe("moved");
    expect(locks).toEqual([]);
    // The control, as for the conflict: a plain status takes it in this state.
    expect((await locksTakenBy(() => simpleGit(repo).status())).locks).toEqual(["index.lock"]);
  });

  it("read a file's unstaged hunks without taking the index lock", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "g"), "y\n");
    git(["add", "g"], repo);
    git(["commit", "-qm", "g"], repo);
    fs.writeFileSync(path.join(repo, "f"), "changed\n");
    makeStatDirty("g");

    const run = { gitPath: "git", repoPath: repo };
    const changed = await locksTakenBy(() => readFileDiff(run, "f", "unstaged"));
    // A file whose timestamp alone moved is the one a diff would refresh the
    // index for, lock and all; it has no hunk to show either way.
    const touched = await locksTakenBy(() => readFileDiff(run, "g", "unstaged"));

    expect(changed.result).toMatchObject({ kind: "hunks" });
    expect(touched.result).toMatchObject({ kind: "none" });
    expect([...changed.locks, ...touched.locks]).toEqual([]);
    expect((await locksTakenBy(() => simpleGit(repo).status())).locks).toEqual(["index.lock"]);
  });
});
