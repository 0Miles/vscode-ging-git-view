import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type FileHistoryEntry,
  loadFileHistory,
  parseFileHistory
} from "@ging/core/backend/queries/fileHistory";

import { git, makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

// One repository, read and never changed by the tests, made once: a file
// renamed partway, changed on two branches that are merged, merged into once
// with a change of the merge's own, copied, and files whose names git would
// read as patterns or options.

let repo: string;
/** Seconds since the epoch, one more for each commit: the walk's order is by
 *  date, and commits made within one second would leave it to chance. */
let clock = 1_700_000_000;

function commit(args: string[]) {
  clock += 60;
  const date = `${clock} +0000`;
  cp.execFileSync("git", args, {
    cwd: repo,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  });
}

const write = (name: string, content: string) =>
  fs.writeFileSync(path.join(repo, name), content);

const LINES = ["one", "two", "three", "four", "five", "six"];
const text = (lines: string[]) => lines.join("\n") + "\n";

/** A blob of `content` in the repository, for a path its working tree could
 *  not hold. */
function blob(content: string): string {
  return cp
    .execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: content })
    .toString()
    .trim();
}

/** Add `file` to the index as `mode` with `object`, past the checks a
 *  checkout on Windows makes of a name (`:` and `*` cannot be on its disk). */
function addToIndex(mode: string, object: string, file: string) {
  git(
    ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `${mode},${object},${file}`],
    repo
  );
}

beforeAll(() => {
  repo = makeRepo(); // "init": file "f"
  write("old.txt", text(LINES));
  git(["add", "old.txt"], repo);
  commit(["commit", "-m", "add old"]);
  write("old.txt", text([...LINES, "seven"]));
  commit(["commit", "-am", "change old"]);
  git(["mv", "old.txt", "new.txt"], repo);
  commit(["commit", "-m", "rename to new"]);

  // Changed on both sides: the merge's file is unlike either parent's.
  git(["checkout", "-q", "-b", "side"], repo);
  write("new.txt", text(["one", "two", "THREE", "four", "five", "six", "seven"]));
  commit(["commit", "-am", "side change"]);
  git(["checkout", "-q", "main"], repo);
  write("new.txt", text([...LINES, "seven", "eight"]));
  commit(["commit", "-am", "main change"]);
  commit(["merge", "--no-edit", "side"]);

  // Changed on one side only: the merge's file is that side's.
  git(["checkout", "-q", "-b", "one-sided"], repo);
  write("new.txt", text(["ONE", "two", "THREE", "four", "five", "six", "seven", "eight"]));
  commit(["commit", "-am", "one-sided change"]);
  git(["checkout", "-q", "main"], repo);
  write("f", "unrelated");
  commit(["commit", "-am", "unrelated change"]);
  commit(["merge", "--no-edit", "one-sided"]);

  // A merge that changes the file itself, which neither side did.
  git(["checkout", "-q", "-b", "elsewhere"], repo);
  write("f", "elsewhere");
  commit(["commit", "-am", "elsewhere change"]);
  git(["checkout", "-q", "main"], repo);
  commit(["merge", "--no-ff", "--no-commit", "elsewhere"]);
  write("new.txt", text(["ONE", "two", "THREE", "four", "five", "six", "seven", "eight", "merged"]));
  git(["add", "new.txt"], repo);
  commit(["commit", "-m", "Merge branch 'elsewhere'"]);

  // A copy, changed afterwards.
  fs.copyFileSync(path.join(repo, "new.txt"), path.join(repo, "copy.txt"));
  git(["add", "copy.txt"], repo);
  commit(["commit", "-m", "copy new"]);
  write("copy.txt", text(["copied", "two", "THREE", "four", "five", "six", "seven", "eight"]));
  commit(["commit", "-am", "change copy"]);

  // Names git would read as a pattern, a magic pathspec or an option.
  write("[ab].txt", "brackets\n");
  write("a.txt", "a\n");
  write("-dash.txt", "dash\n");
  write("sp ace ü.txt", "unicode\n");
  git(["add", "--", "[ab].txt", "a.txt", "-dash.txt", "sp ace ü.txt"], repo);
  addToIndex("100644", blob("colon\n"), ":colon.txt");
  addToIndex("100644", blob("star\n"), "*.txt");
  commit(["commit", "-m", "odd names"]);
  write("a.txt", "a again\n");
  git(["add", "a.txt"], repo);
  commit(["commit", "-m", "change a only"]);

  // A submodule, as its gitlink: moved from one commit to another.
  addToIndex("160000", "1".repeat(40), "sub");
  commit(["commit", "-m", "add sub"]);
  addToIndex("160000", "2".repeat(40), "sub");
  commit(["commit", "-m", "move sub"]);
});

afterAll(() => {
  rmrf(repo);
});

const history = (file: string, start = "HEAD", offset = 0, count = 1000) =>
  loadFileHistory(simpleGit(repo), { start, path: file, offset, count });

/** What each entry says of the file, newest first. */
const summary = (entries: FileHistoryEntry[]) =>
  entries.map(({ subject, change, path: at, oldPath }) => ({ subject, change, at, oldPath }));

describe("loadFileHistory (real git)", () => {
  it("names the file's path at each commit: the old one before the rename, both at it", async () => {
    const { entries, more } = await history("new.txt");

    expect(more).toBe(false);
    expect(summary(entries)).toEqual([
      { subject: "Merge branch 'elsewhere'", change: "M", at: "new.txt", oldPath: "new.txt" },
      { subject: "one-sided change", change: "M", at: "new.txt", oldPath: "new.txt" },
      { subject: "Merge branch 'side'", change: "M", at: "new.txt", oldPath: "new.txt" },
      { subject: "main change", change: "M", at: "new.txt", oldPath: "new.txt" },
      { subject: "side change", change: "M", at: "new.txt", oldPath: "new.txt" },
      { subject: "rename to new", change: "R", at: "new.txt", oldPath: "old.txt" },
      { subject: "change old", change: "M", at: "old.txt", oldPath: "old.txt" },
      { subject: "add old", change: "A", at: "old.txt", oldPath: "old.txt" }
    ]);
  });

  it("lists a merge only where the file it left is unlike every parent's", async () => {
    const { entries } = await history("new.txt");
    const merges = entries.filter((entry) => entry.parents.length > 1);

    // Both sides changed it, and the merge's own change: listed. The merge of
    // a side that alone changed it holds that side's file, and is not.
    expect(merges.map((entry) => entry.subject)).toEqual([
      "Merge branch 'elsewhere'",
      "Merge branch 'side'"
    ]);
    expect(merges[0].parents).toEqual([rev(repo, "HEAD~6^1"), rev(repo, "elsewhere")]);
  });

  it("carries each commit's own fields", async () => {
    const { entries } = await history("new.txt");
    const rename = entries.find((entry) => entry.subject === "rename to new")!;

    expect(rename.hash).toBe(rev(repo, ":/rename to new"));
    expect(rename.parents).toEqual([rev(repo, rename.hash + "^")]);
    expect(rename).toMatchObject({ author: "T", authorEmail: "t@t.com", submodule: null });
    expect(Number.isInteger(rename.date) && rename.date > 1_700_000_000).toBe(true);
    expect(entries.at(-1)!.parents).toEqual([rev(repo, entries.at(-1)!.hash + "^")]);
  });

  it("reads from an older commit only what led up to it", async () => {
    const { entries } = await history("old.txt", rev(repo, ":/change old"));

    expect(entries.map((entry) => entry.subject)).toEqual(["change old", "add old"]);
  });

  it("pages through it, every entry once and in order, saying when there are more", async () => {
    const whole = (await history("new.txt")).entries.map((entry) => entry.hash);

    const pages = await Promise.all([0, 3, 6].map((offset) => history("new.txt", "HEAD", offset, 3)));

    // git prints the one-sided merge too, without a diff of the file, and
    // counts it in `--max-count`: nine printed, eight entries. The pages go by
    // what git printed, so the first holds two entries, and none is lost.
    expect(pages.map((page) => page.more)).toEqual([true, true, false]);
    expect(pages.map((page) => page.entries.length)).toEqual([2, 3, 3]);
    expect(pages.flatMap((page) => page.entries.map((entry) => entry.hash))).toEqual(whole);
    // A page that ends with the history says there is nothing past it.
    expect((await history("new.txt", "HEAD", 0, whole.length + 1)).more).toBe(false);
    expect((await history("new.txt", "HEAD", whole.length + 1, 3)).entries).toEqual([]);
  });

  it("follows a copy back into the history of the file it was copied from", async () => {
    const { entries } = await history("copy.txt");

    // A limit of `--follow`, kept: past the copy, the source's history.
    expect(summary(entries).slice(0, 3)).toEqual([
      { subject: "change copy", change: "M", at: "copy.txt", oldPath: "copy.txt" },
      { subject: "copy new", change: "C", at: "copy.txt", oldPath: "new.txt" },
      { subject: "Merge branch 'elsewhere'", change: "M", at: "new.txt", oldPath: "new.txt" }
    ]);
  });

  it.each([
    ["[ab].txt", "a pattern that would match a.txt"],
    ["-dash.txt", "a leading dash"],
    [":colon.txt", "a leading colon, git's magic pathspec"],
    ["*.txt", "a wildcard that would match every .txt"],
    ["sp ace ü.txt", "spaces and a non-ASCII letter"]
  ])("takes %s literally: %s", async (file) => {
    const { entries } = await history(file);

    expect(summary(entries)).toEqual([
      { subject: "odd names", change: "A", at: file, oldPath: file }
    ]);
  });

  it("names a submodule's entries by the commits its gitlink moved between", async () => {
    const { entries } = await history("sub");

    expect(entries.map(({ subject, change, submodule }) => ({ subject, change, submodule }))).toEqual(
      [
        {
          subject: "move sub",
          change: "M",
          submodule: { from: "1".repeat(40), to: "2".repeat(40) }
        },
        { subject: "add sub", change: "A", submodule: { from: null, to: "1".repeat(40) } }
      ]
    );
  });

  it("has nothing for a path no commit changed", async () => {
    expect(await history("never-there.txt")).toEqual({ entries: [], more: false });
  });
});

describe("parseFileHistory", () => {
  it("reads nothing out of nothing", () => {
    expect(parseFileHistory("")).toEqual([]);
  });

  it("keeps a path's own spaces, and reads a combined diff's one path", () => {
    const record = (fields: string[], diff: string) =>
      "\x01\x02\x03" + fields.join("\0") + "\0" + diff;
    const out =
      record(
        ["a".repeat(40), "b".repeat(40), "A", "a@x", "1", "s"],
        "\0\n:100644 100644 " + "1".repeat(40) + " " + "2".repeat(40) + " R087\0 old \0 new \0"
      ) +
      record(
        ["c".repeat(40), "d".repeat(40) + " " + "e".repeat(40), "C", "c@x", "2", "m"],
        "\0\0::100644 100644 100644 " + "1".repeat(40) + " 2".repeat(1) + "2".repeat(39) + " " + "3".repeat(40) + " MM\0 both \0"
      );

    expect(summary(parseFileHistory(out))).toEqual([
      { subject: "s", change: "R", at: " new ", oldPath: " old " },
      { subject: "m", change: "M", at: " both ", oldPath: " both " }
    ]);
  });
});
