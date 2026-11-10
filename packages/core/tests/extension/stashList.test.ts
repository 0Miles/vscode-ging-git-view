import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { commitDiffView } from "@ging/core/extension/commitDiff";
import { copyStashName, loadStashFiles, stashListItems } from "@ging/core/extension/stashList";
import type { ScmStashEntry } from "@ging/shared/backend/types";

import { git, makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

const entry = (hash: string, index: number, message = "On main: wip"): ScmStashEntry => ({
  hash,
  ref: `stash@{${index}}`,
  index,
  message,
  date: 1_700_000_000
});

describe("stashListItems", () => {
  it("names each item by its stash's SHA, whatever its position", () => {
    const items = stashListItems([entry("aaa", 0, "On main: a"), entry("bbb", 1, "On main: b")]);
    expect(items).toEqual([
      {
        id: "aaa",
        hash: "aaa",
        selector: "stash@{0}",
        message: "On main: a",
        date: 1_700_000_000
      },
      {
        id: "bbb",
        hash: "bbb",
        selector: "stash@{1}",
        message: "On main: b",
        date: 1_700_000_000
      }
    ]);
  });

  it("keeps ids unique when one commit is stored in the stash twice", () => {
    // `git stash store` takes any commit, so one SHA can sit at two positions;
    // a tree view refuses two items with the same id.
    const ids = stashListItems([entry("aaa", 0), entry("bbb", 1), entry("aaa", 2)]).map(
      (i) => i.id
    );
    expect(new Set(ids).size).toBe(3);
    expect(ids.slice(0, 2)).toEqual(["aaa", "bbb"]);
  });
});

describe("copyStashName", () => {
  /** Copy Name on the item showing `shown`, with git now listing `now`. */
  async function copy(now: ScmStashEntry[], shown: { hash: string; selector: string }) {
    const copied: string[] = [];
    const calls = { warned: 0, refreshed: 0 };
    const outcome = await copyStashName(
      {
        listStashes: () => Promise.resolve(now),
        writeClipboard: (text) => {
          copied.push(text);
          return Promise.resolve();
        },
        warn: () => calls.warned++,
        refresh: () => calls.refreshed++
      },
      shown
    );
    return { outcome, copied, ...calls };
  }

  it("copies the shown selector while the stash still sits there", async () => {
    expect(
      await copy([entry("aaa", 0), entry("bbb", 1)], { hash: "bbb", selector: "stash@{1}" })
    ).toEqual({ outcome: "copied", copied: ["stash@{1}"], warned: 0, refreshed: 0 });
  });

  it("refuses, copying nothing, once the stash has moved", async () => {
    // A newer push moved bbb from stash@{0} to stash@{1} after the list was read.
    expect(
      await copy([entry("ccc", 0), entry("bbb", 1)], { hash: "bbb", selector: "stash@{0}" })
    ).toEqual({ outcome: "refused", copied: [], warned: 1, refreshed: 1 });
  });

  it("refuses, copying nothing, once the stash is gone", async () => {
    expect(await copy([entry("aaa", 0)], { hash: "bbb", selector: "stash@{0}" })).toEqual({
      outcome: "refused",
      copied: [],
      warned: 1,
      refreshed: 1
    });
  });
});

describe("loadStashFiles (real git)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmrf(repo);
  });

  /** What `git show <revision>:<path>` reads, or null when there's no such file. */
  const show = (revision: string, file: string): string | null => {
    try {
      return cp
        .execFileSync("git", ["show", `${revision}:${file}`], { cwd: repo, stdio: "pipe" })
        .toString();
    } catch {
      return null;
    }
  };

  it("lists tracked and untracked files, each diffing what the stash changed", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.mkdirSync(path.join(repo, "dir"));
    fs.writeFileSync(path.join(repo, "dir", "new.txt"), "untracked");
    git(["stash", "push", "--include-untracked", "-m", "both"], repo);
    const hash = rev(repo, "stash@{0}");

    const files = await loadStashFiles(simpleGit(repo), repo, hash);

    expect(files?.map(({ name, dir, badge }) => ({ name, dir, badge }))).toEqual([
      { name: "f", dir: "", badge: "M" },
      { name: "new.txt", dir: "dir", badge: "U" }
    ]);
    const labels = { addedIn: (h: string) => `added ${h}`, deletedIn: (h: string) => `del ${h}` };
    const [tracked, untracked] = files!.map((file) => commitDiffView(file.diff, labels));
    // Tracked: the stash's base (stash^1) against the stash.
    expect(show(tracked.left.commit, tracked.left.filePath)).toBe("x");
    expect(show(tracked.right.commit, tracked.right.filePath)).toBe("changed");
    // Untracked: nothing on the left, the stash's third parent on the right.
    expect(show(untracked.left.commit, untracked.left.filePath)).toBeNull();
    expect(untracked.right.commit).toBe(hash + "^3");
    expect(show(untracked.right.commit, untracked.right.filePath)).toBe("untracked");
  });

  it("leaves out what only the index (stash^2) changed", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "staged");
    git(["add", "f"], repo);
    fs.writeFileSync(path.join(repo, "f"), "x");
    git(["stash", "push", "-m", "index only"], repo);

    const files = await loadStashFiles(simpleGit(repo), repo, rev(repo, "stash@{0}"));

    expect(files).toEqual([]);
  });

  it("is null when the stash can't be read", async () => {
    repo = makeRepo();
    expect(await loadStashFiles(simpleGit(repo), repo, "0".repeat(40))).toBeNull();
  });
});
