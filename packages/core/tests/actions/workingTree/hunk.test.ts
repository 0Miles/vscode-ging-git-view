import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyHunk, type HunkChoice, StaleHunkError } from "@ging/core/backend/actions/hunk";
import { cutFileDiff, offeredHunks, readFileDiff } from "@ging/core/backend/queries/fileHunks";
import type { FileHunks, HunkArea } from "@ging/shared/backend/types";

import { git, makeRepo, rejection, rmrf } from "@ging/core/tests/helpers";

// Hunk staging (#406): a file's diff cut into hunks by git, and one of them
// staged or unstaged with `git apply --cached`, on real repositories.

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

function repo(): string {
  const dir = makeRepo();
  cleanUp.push(dir);
  return dir;
}

/** `git <args>`'s output, as bytes. */
const bytes = (dir: string, ...args: string[]) => cp.execFileSync("git", args, { cwd: dir });
/** The index's copy of `file`, as bytes. */
const indexed = (dir: string, file: string) => bytes(dir, "show", `:0:${file}`);
const lines = (from: number, to: number, change: (n: number) => string = String) =>
  Array.from({ length: to - from + 1 }, (_, i) => change(from + i));

/** `file` committed with `content` (lines joined with `eol`, ending on it). */
function commit(dir: string, file: string, content: string | Buffer) {
  fs.writeFileSync(path.join(dir, file), content);
  git(["add", "--", file], dir);
  git(["commit", "-qm", `add ${file}`], dir);
}

/** `s` in windows-1252, whose characters here are latin1's. */
const win1252 = (s: string) => Buffer.from(s, "latin1");

const run = (dir: string) => ({ gitPath: "git", repoPath: dir });
const read = async (dir: string, file: string, area: HunkArea): Promise<FileHunks> =>
  offeredHunks(await readFileDiff(run(dir), file, area));

/** Apply hunk `index` of `file`'s diff in `area`, as last read. */
async function apply(dir: string, file: string, area: HunkArea, index: number) {
  const hunks = await read(dir, file, area);
  if (hunks.kind !== "hunks") throw new Error(`no hunks: ${hunks.reason}`);
  await applyHunk(run(dir), { path: file, area, token: hunks.token, hunk: index });
}

/** Thirty numbered lines, three of them changed far apart: three hunks. */
const THIRTY = lines(1, 30);
const CHANGED = lines(1, 30, (n) =>
  n === 3 ? "three" : n === 15 ? "fifteen" : n === 28 ? "x28" : String(n)
);
const text = (ls: string[], eol = "\n") => ls.join(eol) + eol;

describe("reading a file's hunks", () => {
  it("cuts the unstaged diff into git's hunks, with the lines each spans on both sides", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    // Two lines more in the first hunk: the later ones start further down
    // in the working tree than in the index.
    const changed = [...CHANGED];
    changed.splice(3, 0, "three-b", "three-c");
    fs.writeFileSync(path.join(r, "n.txt"), text(changed));

    const hunks = await read(r, "n.txt", "unstaged");

    expect(hunks).toEqual({
      kind: "hunks",
      token: expect.stringMatching(/^[0-9a-f]{40}$/),
      hunks: [
        { original: { start: 1, count: 6 }, modified: { start: 1, count: 8 } },
        { original: { start: 12, count: 7 }, modified: { start: 14, count: 7 } },
        { original: { start: 25, count: 6 }, modified: { start: 27, count: 6 } }
      ]
    });
  });

  it("reads the staged diff, HEAD against the index", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));
    git(["add", "n.txt"], r);

    const staged = await read(r, "n.txt", "staged");
    const unstaged = await read(r, "n.txt", "unstaged");

    expect(staged.kind === "hunks" && staged.hunks).toHaveLength(3);
    expect(unstaged).toEqual({ kind: "none", reason: "unchanged" });
  });

  it("names a diff by a token that changes with it", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));
    const first = await read(r, "n.txt", "unstaged");
    const again = await read(r, "n.txt", "unstaged");
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED) + "31\n");
    const changed = await read(r, "n.txt", "unstaged");

    expect(first.kind === "hunks" && first.token).toBe(again.kind === "hunks" && again.token);
    expect(first.kind === "hunks" && first.token).not.toBe(
      changed.kind === "hunks" && changed.token
    );
  });

  it("offers no hunk of a file whose change is the whole file", async () => {
    const r = repo();
    commit(r, "gone.txt", "gone\n");
    commit(r, "old.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "untracked.txt"), "new\n");
    fs.writeFileSync(path.join(r, "added.txt"), "added\n");
    git(["add", "added.txt"], r);
    fs.writeFileSync(path.join(r, "intent.txt"), "intended\n");
    git(["add", "-N", "intent.txt"], r);
    fs.rmSync(path.join(r, "gone.txt"));
    git(["mv", "old.txt", "renamed.txt"], r);
    fs.writeFileSync(path.join(r, "bin.dat"), Buffer.from([0, 1, 2, 0]));
    git(["add", "bin.dat"], r);

    expect(await read(r, "untracked.txt", "unstaged")).toEqual({
      kind: "none",
      reason: "unchanged"
    });
    expect(await read(r, "added.txt", "staged")).toEqual({ kind: "none", reason: "added" });
    expect(await read(r, "intent.txt", "unstaged")).toEqual({ kind: "none", reason: "added" });
    expect(await read(r, "gone.txt", "unstaged")).toEqual({ kind: "none", reason: "deleted" });
    // One path of a rename: the other half is a path of its own.
    expect(await read(r, "renamed.txt", "staged")).toEqual({ kind: "none", reason: "added" });
    expect(await read(r, "old.txt", "staged")).toEqual({ kind: "none", reason: "deleted" });
    // A new binary file is binary first.
    expect(await read(r, "bin.dat", "staged")).toEqual({ kind: "none", reason: "binary" });
  });

  it("offers no hunk of a binary file, or a change of mode alone", async () => {
    const r = repo();
    commit(r, "bin.dat", Buffer.from([0, 1, 2, 0]));
    commit(r, "mode.sh", "echo\n");
    fs.writeFileSync(path.join(r, "bin.dat"), Buffer.from([0, 9, 9, 0]));
    git(["update-index", "--chmod=+x", "mode.sh"], r);

    expect(await read(r, "bin.dat", "unstaged")).toEqual({ kind: "none", reason: "binary" });
    expect(await read(r, "mode.sh", "staged")).toEqual({ kind: "none", reason: "notText" });
  });

  it("offers no hunk of a symbolic link or a submodule", () => {
    // Read off the diff git writes for them: neither is a file of lines.
    const link = [
      "diff --git a/l b/l",
      "index 1111111..2222222 120000",
      "--- a/l",
      "+++ b/l",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "\\ No newline at end of file",
      ""
    ].join("\n");
    const submodule = [
      "diff --git a/s b/s",
      "index 1111111..2222222 160000",
      "--- a/s",
      "+++ b/s",
      "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111",
      "+Subproject commit 2222222222222222222222222222222222222222",
      ""
    ].join("\n");

    expect(cutFileDiff(link)).toEqual({ kind: "none", reason: "notText" });
    expect(cutFileDiff(submodule)).toEqual({ kind: "none", reason: "notText" });
  });

  it("offers no hunk of a file in conflict", async () => {
    const r = repo();
    commit(r, "c.txt", "base\n");
    git(["checkout", "-qb", "other"], r);
    commit(r, "c.txt", "other\n");
    git(["checkout", "-q", "main"], r);
    commit(r, "c.txt", "main\n");
    expect(() => git(["merge", "other"], r)).toThrow();

    expect(await read(r, "c.txt", "unstaged")).toEqual({ kind: "none", reason: "conflicted" });
    expect(await read(r, "c.txt", "staged")).toEqual({ kind: "none", reason: "conflicted" });
  });

  it("refuses a path that names more than one file", async () => {
    const r = repo();
    fs.mkdirSync(path.join(r, "d"));
    commit(r, "d/a.txt", "a\n");
    commit(r, "d/b.txt", "b\n");
    fs.writeFileSync(path.join(r, "d/a.txt"), "A\n");
    fs.writeFileSync(path.join(r, "d/b.txt"), "B\n");

    expect(String(await rejection(read(r, "d", "unstaged")))).toContain("no single file");
  });

  it("reads the diff in spite of the user's diff settings", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    for (const [key, value] of [
      ["diff.noprefix", "true"],
      ["color.ui", "always"],
      ["diff.context", "10"],
      ["diff.external", "false"],
      ["diff.suppressBlankEmpty", "true"]
    ]) {
      git(["config", key, value], r);
    }
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));

    const hunks = await read(r, "n.txt", "unstaged");

    expect(hunks.kind === "hunks" && hunks.hunks).toHaveLength(3);
    await apply(r, "n.txt", "unstaged", 1);
    expect(indexed(r, "n.txt").toString()).toBe(
      text(lines(1, 30, (n) => (n === 15 ? "fifteen" : String(n))))
    );
  });
});

describe("staging and unstaging one hunk", () => {
  it("stages one hunk of three, and leaves the working tree as it is", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));

    await apply(r, "n.txt", "unstaged", 1);

    expect(indexed(r, "n.txt").toString()).toBe(
      text(lines(1, 30, (n) => (n === 15 ? "fifteen" : String(n))))
    );
    expect(fs.readFileSync(path.join(r, "n.txt"), "utf8")).toBe(text(CHANGED));
    const left = await read(r, "n.txt", "unstaged");
    expect(left.kind === "hunks" && left.hunks.map((h) => h.original.start)).toEqual([1, 25]);
  });

  it("stages a hunk after another that adds lines, unstaged, at its place in the index", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    const changed = [...CHANGED];
    changed.splice(3, 0, "three-b", "three-c");
    fs.writeFileSync(path.join(r, "n.txt"), text(changed));

    await apply(r, "n.txt", "unstaged", 2);

    expect(indexed(r, "n.txt").toString()).toBe(
      text(lines(1, 30, (n) => (n === 28 ? "x28" : String(n))))
    );
  });

  it("unstages one hunk of what is staged, back to HEAD's lines, the working tree untouched", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));
    git(["add", "n.txt"], r);

    await apply(r, "n.txt", "staged", 0);

    expect(indexed(r, "n.txt").toString()).toBe(
      text(lines(1, 30, (n) => (n === 15 ? "fifteen" : n === 28 ? "x28" : String(n))))
    );
    expect(fs.readFileSync(path.join(r, "n.txt"), "utf8")).toBe(text(CHANGED));
  });

  it("keeps a file's CRLF line endings, committed as they are", async () => {
    const r = repo();
    commit(r, "crlf.txt", text(THIRTY, "\r\n"));
    fs.writeFileSync(path.join(r, "crlf.txt"), text(CHANGED, "\r\n"));

    await apply(r, "crlf.txt", "unstaged", 2);

    expect(indexed(r, "crlf.txt").toString()).toBe(
      text(
        lines(1, 30, (n) => (n === 28 ? "x28" : String(n))),
        "\r\n"
      )
    );
  });

  it("stages from a CRLF working tree into an LF index with core.autocrlf on", async () => {
    const r = repo();
    git(["config", "core.autocrlf", "true"], r);
    commit(r, "auto.txt", text(THIRTY));
    // As a Windows checkout has it: CRLF in the working tree, LF in git.
    fs.writeFileSync(path.join(r, "auto.txt"), text(CHANGED, "\r\n"));

    const hunks = await read(r, "auto.txt", "unstaged");
    await apply(r, "auto.txt", "unstaged", 0);

    expect(hunks.kind === "hunks" && hunks.hunks).toHaveLength(3);
    expect(indexed(r, "auto.txt").toString()).toBe(
      text(lines(1, 30, (n) => (n === 3 ? "three" : String(n))))
    );
  });

  it("stages a hunk at the end of a file with no newline at its end", async () => {
    const r = repo();
    commit(r, "eof.txt", THIRTY.join("\n"));
    fs.writeFileSync(
      path.join(r, "eof.txt"),
      [...CHANGED.slice(0, 29), "thirty", "more"].join("\n")
    );

    await apply(r, "eof.txt", "unstaged", 2);

    expect(indexed(r, "eof.txt").toString()).toBe(
      [...THIRTY.slice(0, 27), "x28", "29", "thirty", "more"].join("\n")
    );
  });

  it("stages a file's bytes as they are, whatever its encoding", async () => {
    const r = repo();
    // windows-1252 and Big5: neither is UTF-8, and a decode would spoil them.
    const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]);
    const file = (first: Buffer, last: Buffer) =>
      Buffer.concat([
        first,
        Buffer.from("\n" + lines(2, 29).join("\n") + "\n"),
        last,
        Buffer.from("\n")
      ]);
    commit(r, "enc.txt", file(win1252("caf\xe9"), win1252("na\xefve")));
    fs.writeFileSync(path.join(r, "enc.txt"), file(win1252("CAF\xc9"), big5));

    await apply(r, "enc.txt", "unstaged", 1);

    expect(indexed(r, "enc.txt")).toEqual(file(win1252("caf\xe9"), big5));
  });

  it("applies a hunk whose lines end in whitespace, whatever the user's apply.whitespace", async () => {
    const r = repo();
    git(["config", "apply.whitespace", "error"], r);
    commit(r, "ws.txt", text(THIRTY));
    fs.writeFileSync(
      path.join(r, "ws.txt"),
      text(lines(1, 30, (n) => (n === 3 ? "three   " : String(n))))
    );

    await apply(r, "ws.txt", "unstaged", 0);

    expect(indexed(r, "ws.txt").toString()).toContain("three   \n");
  });

  it("takes a file's name as written, not as a pattern", async () => {
    const r = repo();
    commit(r, "[ab].txt", text(THIRTY));
    commit(r, "a.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "[ab].txt"), text(CHANGED));
    fs.writeFileSync(path.join(r, "a.txt"), text(CHANGED));

    await apply(r, "[ab].txt", "unstaged", 0);

    expect(bytes(r, "diff", "--cached", "--name-only").toString()).toBe("[ab].txt\n");
  });

  it("refuses a hunk of a diff that changed since it was read, and changes nothing", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));
    const shown = await read(r, "n.txt", "unstaged");
    if (shown.kind !== "hunks") throw new Error("no hunks");
    // Edited again on disk: one more line at the top moves every hunk down.
    fs.writeFileSync(path.join(r, "n.txt"), "zero\n" + text(CHANGED));
    const choice: HunkChoice = { path: "n.txt", area: "unstaged", token: shown.token, hunk: 1 };

    expect(await rejection(applyHunk(run(r), choice))).toBeInstanceOf(StaleHunkError);
    expect(indexed(r, "n.txt").toString()).toBe(text(THIRTY));
  });

  it("refuses a hunk once the index changed under its diff", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));
    const shown = await read(r, "n.txt", "unstaged");
    if (shown.kind !== "hunks") throw new Error("no hunks");
    await apply(r, "n.txt", "unstaged", 0);
    const staged = indexed(r, "n.txt");

    const stale = applyHunk(run(r), {
      path: "n.txt",
      area: "unstaged",
      token: shown.token,
      hunk: 1
    });

    expect(await rejection(stale)).toBeInstanceOf(StaleHunkError);
    expect(indexed(r, "n.txt")).toEqual(staged);
  });

  it("refuses a hunk the diff does not have", async () => {
    const r = repo();
    commit(r, "n.txt", text(THIRTY));
    fs.writeFileSync(path.join(r, "n.txt"), text(CHANGED));
    const shown = await read(r, "n.txt", "unstaged");
    if (shown.kind !== "hunks") throw new Error("no hunks");

    const refusal = (hunk: number) =>
      rejection(
        applyHunk(run(r), {
          path: "n.txt",
          area: "unstaged",
          token: shown.token,
          hunk
        })
      );

    expect(await refusal(3)).toBeInstanceOf(StaleHunkError);
    expect(await refusal(-1)).toBeInstanceOf(StaleHunkError);
    expect(await refusal(1.5)).toBeInstanceOf(StaleHunkError);
    expect(indexed(r, "n.txt").toString()).toBe(text(THIRTY));
  });
});
