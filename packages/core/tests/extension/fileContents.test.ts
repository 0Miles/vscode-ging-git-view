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

describe("readFileAtRevision", () => {
  it("reads a file at a commit in the encoding asked for", async () => {
    const r = newRepo();
    const text = "café déjà\n";
    fs.writeFileSync(path.join(r, "legacy.txt"), encode(text, "win1252"));
    git(["add", "."], r);
    git(["commit", "-m", "add legacy"], r);
    const side = { repo: r, filePath: "legacy.txt", commit: rev(r, "HEAD") };

    expect(await readFileAtRevision("git", side, "win1252")).toBe(text);
    expect(await readFileAtRevision("git", side, "utf8")).not.toBe(text);
  });

  it("reads the index as the revision `:0`", async () => {
    // What a working tree's staged side is (#403, #406): not a commit.
    const r = newRepo();
    fs.writeFileSync(path.join(r, "staged.txt"), "staged\n");
    git(["add", "staged.txt"], r);
    fs.writeFileSync(path.join(r, "staged.txt"), "staged, then changed\n");

    expect(
      await readFileAtRevision("git", { repo: r, filePath: "staged.txt", commit: ":0" }, "utf8")
    ).toBe("staged\n");
  });

  it("reads a file the revision does not have as empty", async () => {
    const r = newRepo();
    expect(
      await readFileAtRevision("git", { repo: r, filePath: "nope.txt", commit: "HEAD" }, "utf8")
    ).toBe("");
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

    expect(await readWorkingFile(file, "win1252")).toBe("naïve\n");
    expect(await readWorkingFile(file, "utf8")).not.toBe("naïve\n");
  });

  it("falls back to utf8 for an encoding it does not know", async () => {
    const file = path.join(scratch(), "plain.txt");
    fs.writeFileSync(file, "héllo\n");

    expect(await readWorkingFile(file, "not-a-real-encoding")).toBe("héllo\n");
  });

  it("reads a file the working tree no longer has as empty", async () => {
    expect(await readWorkingFile(path.join(scratch(), "deleted.txt"), "utf8")).toBe("");
  });

  it("rejects a path that is there but is no file it can read", async () => {
    await expect(readWorkingFile(scratch(), "utf8")).rejects.toThrow();
  });
});
