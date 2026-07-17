import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { encode } from "iconv-lite";
import { afterEach, describe, expect, it } from "vitest";

import { getCommitFileContent } from "@/backend/queries/commitFileContent";

import { git, makeRepo } from "@tests/backend/helpers";

const repos: string[] = [];
function newRepo(): string {
  const r = makeRepo();
  repos.push(r);
  return r;
}
function head(repo: string): string {
  return cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

afterEach(() => {
  for (const r of repos.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("getCommitFileContent", () => {
  it("returns a utf8 file's contents at a commit", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "f.txt"), "héllo wörld\n");
    git(["add", "."], r);
    git(["commit", "-m", "add f"], r);
    const content = await getCommitFileContent("git", r, head(r), "f.txt", "utf8");
    expect(content).toBe("héllo wörld\n");
  });

  it("decodes a file stored in a non-utf8 encoding (win1252)", async () => {
    const r = newRepo();
    const text = "café déjà\n";
    fs.writeFileSync(path.join(r, "legacy.txt"), encode(text, "win1252"));
    git(["add", "."], r);
    git(["commit", "-m", "add legacy"], r);
    const hash = head(r);

    // Decoded with the right encoding the accents come back intact...
    expect(await getCommitFileContent("git", r, hash, "legacy.txt", "win1252")).toBe(text);
    // ...whereas utf8 would mangle the high bytes (so they must differ).
    expect(await getCommitFileContent("git", r, hash, "legacy.txt", "utf8")).not.toBe(text);
  });

  it("falls back to utf8 for an unknown encoding name", async () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, "f.txt"), "plain\n");
    git(["add", "."], r);
    git(["commit", "-m", "add f"], r);
    expect(await getCommitFileContent("git", r, head(r), "f.txt", "not-a-real-encoding")).toBe(
      "plain\n"
    );
  });

  it("returns an empty string when the path doesn't exist at the commit", async () => {
    const r = newRepo();
    const content = await getCommitFileContent("git", r, head(r), "does-not-exist.txt", "utf8");
    expect(content).toBe("");
  });
});
