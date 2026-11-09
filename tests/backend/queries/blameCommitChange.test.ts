import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { blameCommitChange, hunkAt } from "@/backend/queries/blameCommitChange";
import { blameFile } from "@/backend/queries/blameFile";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

const repos: string[] = [];
function newRepo(): string {
  const r = makeRepo();
  repos.push(r);
  return r;
}
function commit(repo: string, message: string) {
  git(["add", "-A"], repo);
  git(["commit", "-m", message], repo);
}
function head(repo: string): string {
  return cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}
const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);

afterEach(() => {
  for (const r of repos.splice(0)) rmrf(r);
});

/** What the hover shows for the line `line` (0-based) of `file` as blamed today. */
async function changeOf(repo: string, file: string, line: number) {
  const blamed = await blameFile({ gitPath: "git", repoPath: repo, filePath: file });
  const target = blamed![line];
  const change = await blameCommitChange({
    gitPath: "git",
    repoPath: repo,
    sha: target.sha,
    filename: target.filename,
    previous: target.previous
  });
  return {
    target,
    change,
    hunk: change === null ? null : hunkAt(change.hunks, target.originalLine)
  };
}

describe("blameCommitChange (real git)", () => {
  it("returns the commit's full message and the hunk that holds the blamed line", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), numbered(1, 30).join("\n") + "\n");
    commit(r, "add a");
    const edited = numbered(1, 30);
    edited[2] = "line 3 changed";
    edited[24] = "line 25 changed";
    fs.writeFileSync(path.join(r, "a.txt"), edited.join("\n") + "\n");
    commit(r, "edit two far-apart lines\n\nThe body\nspans two lines.");

    const { change, hunk } = await changeOf(r, "a.txt", 24);

    expect(change?.message).toBe("edit two far-apart lines\n\nThe body\nspans two lines.");
    // Two hunks, far enough apart that git keeps them separate; the second one.
    expect(change?.hunks).toHaveLength(2);
    expect(hunk).toEqual({
      lines: [
        " line 22",
        " line 23",
        " line 24",
        "-line 25",
        "+line 25 changed",
        " line 26",
        " line 27",
        " line 28"
      ],
      index: 4
    });
  });

  it("diffs a renamed file against its old name", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "old.txt"), numbered(1, 10).join("\n") + "\n");
    commit(r, "add old");
    git(["mv", "old.txt", "new.txt"], r);
    const edited = numbered(1, 10);
    edited[4] = "line 5 changed";
    fs.writeFileSync(path.join(r, "new.txt"), edited.join("\n") + "\n");
    commit(r, "rename and edit");

    const { target, hunk } = await changeOf(r, "new.txt", 4);

    expect(target.previous?.filename).toBe("old.txt");
    // Only the edited line, not the whole file as if it were new.
    expect(hunk?.lines.filter((l) => l.startsWith("+"))).toEqual(["+line 5 changed"]);
    expect(hunk?.lines[hunk.index]).toBe("+line 5 changed");
  });

  it("returns the whole added file for a root commit", async () => {
    const r = newRepo();
    // makeRepo's root commit adds `f` holding "x".
    const { target, change, hunk } = await changeOf(r, "f", 0);

    expect(target.previous).toBeNull();
    expect(change?.message).toBe("init");
    // git's "\ No newline at end of file" marker is not a line of the file.
    expect(hunk).toEqual({ lines: ["+x"], index: 0 });
  });

  it("finds no hunk for a line the commit didn't touch", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "a.txt"), numbered(1, 30).join("\n") + "\n");
    commit(r, "add a");
    const first = head(r);
    fs.writeFileSync(path.join(r, "a.txt"), ["line 0", ...numbered(1, 30)].join("\n") + "\n");
    commit(r, "prepend");

    const change = await blameCommitChange({
      gitPath: "git",
      repoPath: r,
      sha: head(r),
      filename: "a.txt",
      previous: { sha: first, filename: "a.txt" }
    });

    expect(change).not.toBeNull();
    expect(hunkAt(change!.hunks, 20)).toBeNull();
  });

  it("resolves null when git fails", async () => {
    const r = newRepo();
    const change = await blameCommitChange({
      gitPath: "git",
      repoPath: r,
      sha: "0123456789abcdef0123456789abcdef01234567",
      filename: "f",
      previous: null
    });
    expect(change).toBeNull();
  });
});
