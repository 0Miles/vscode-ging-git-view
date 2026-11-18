import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { encode } from "iconv-lite";
import { afterEach, describe, expect, it } from "vitest";

import { readFileAtRevision, readWorkingFile } from "@ging/core/extension/fileContents";

import { git, makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

function newRepo(): string {
  const r = makeRepo();
  dirs.push(r);
  return r;
}

const text = (t: string) => ({ kind: "text", text: t });

describe("readFileAtRevision", () => {
  it("reads a file at a commit in the encoding asked for", async () => {
    const r = newRepo();
    const content = "café déjà\n";
    fs.writeFileSync(path.join(r, "legacy.txt"), encode(content, "win1252"));
    git(["add", "."], r);
    git(["commit", "-m", "add legacy"], r);
    const side = { repo: r, filePath: "legacy.txt", commit: rev(r, "HEAD") };

    expect(await readFileAtRevision("git", side, "win1252")).toEqual(text(content));
    expect(await readFileAtRevision("git", side, "utf8")).not.toEqual(text(content));
  });

  it("reads the index as the revision `:0`", async () => {
    // What a working tree's staged side is (#403, #406): not a commit.
    const r = newRepo();
    fs.writeFileSync(path.join(r, "staged.txt"), "staged\n");
    git(["add", "staged.txt"], r);
    fs.writeFileSync(path.join(r, "staged.txt"), "staged, then changed\n");

    expect(
      await readFileAtRevision("git", { repo: r, filePath: "staged.txt", commit: ":0" }, "utf8")
    ).toEqual(text("staged\n"));
  });

  it("reads a file the revision does not have as empty", async () => {
    const r = newRepo();
    expect(
      await readFileAtRevision("git", { repo: r, filePath: "nope.txt", commit: "HEAD" }, "utf8")
    ).toEqual(text(""));
  });

  it("says a file with a NUL in its first 8000 bytes is binary, as git does", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    fs.writeFileSync(
      path.join(r, "late.txt"),
      Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])])
    );
    git(["add", "."], r);
    git(["commit", "-m", "binary"], r);
    const at = (filePath: string) => ({ repo: r, filePath, commit: rev(r, "HEAD") });

    expect(await readFileAtRevision("git", at("image.bin"), "utf8")).toEqual({ kind: "binary" });
    // Past where git looks: text, NUL and all.
    expect((await readFileAtRevision("git", at("late.txt"), "utf8")).kind).toBe("text");
  });

  it("does not read a file larger than the limit", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "big.txt"), "x".repeat(200_000));
    git(["add", "."], r);
    git(["commit", "-m", "big"], r);
    const side = { repo: r, filePath: "big.txt", commit: rev(r, "HEAD") };

    expect(await readFileAtRevision("git", side, "utf8", 100_000)).toEqual({ kind: "tooLarge" });
    expect((await readFileAtRevision("git", side, "utf8", 200_000)).kind).toBe("text");
  });

  it("never hands git a revision that reads as an option", async () => {
    const r = newRepo();
    const written = path.join(r, "written.txt");

    expect(
      await readFileAtRevision(
        "git",
        { repo: r, filePath: "x", commit: `--output=${written}` },
        "utf8"
      )
    ).toEqual(text(""));
    expect(fs.existsSync(written)).toBe(false);
  });
});

describe("readWorkingFile", () => {
  const scratch = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ging-file-contents-"));
    dirs.push(d);
    return d;
  };

  it("decodes the working tree's file in the encoding asked for", async () => {
    const file = path.join(scratch(), "legacy.txt");
    fs.writeFileSync(file, encode("naïve\n", "win1252"));

    expect(await readWorkingFile(file, "win1252")).toEqual(text("naïve\n"));
    expect(await readWorkingFile(file, "utf8")).not.toEqual(text("naïve\n"));
  });

  it("falls back to utf8 for an encoding it does not know", async () => {
    const file = path.join(scratch(), "plain.txt");
    fs.writeFileSync(file, "héllo\n");

    expect(await readWorkingFile(file, "not-a-real-encoding")).toEqual(text("héllo\n"));
  });

  it("reads a file the working tree no longer has as empty", async () => {
    expect(await readWorkingFile(path.join(scratch(), "deleted.txt"), "utf8")).toEqual(text(""));
  });

  it("says a binary file is binary, and a file over the limit too large, without reading it", async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "a.bin"), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(2000));

    expect(await readWorkingFile(path.join(dir, "a.bin"), "utf8")).toEqual({ kind: "binary" });
    expect(await readWorkingFile(path.join(dir, "big.txt"), "utf8", 1000)).toEqual({
      kind: "tooLarge"
    });
  });

  it("rejects a path that is there but is no file it can read", async () => {
    await expect(readWorkingFile(scratch(), "utf8")).rejects.toThrow();
  });
});
