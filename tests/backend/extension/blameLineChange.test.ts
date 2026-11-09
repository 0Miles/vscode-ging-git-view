import { describe, expect, it } from "vitest";

import type { BlameLine } from "@/backend/queries/blameFile";
import { lineChangeArgs, lineChangeDiff, lineChangeOf } from "@/extension/blameLineChange";

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const REPOS = ["/repo", "/other"];

function line(overrides: Partial<BlameLine> = {}): BlameLine {
  return {
    sha: SHA,
    uncommitted: false,
    authorName: "Bea",
    authorEmail: "bea@example.com",
    authorTime: 0,
    summary: "Fix the thing",
    originalLine: 7,
    filename: "src/a.ts",
    previous: { sha: PARENT, filename: "src/a.ts" },
    ...overrides
  };
}

describe("lineChangeDiff", () => {
  it("compares the commit's file with the previous commit's, at the line in the commit", () => {
    expect(lineChangeDiff(lineChangeOf("/repo", line()))).toEqual({
      repo: "/repo",
      commitHash: SHA,
      oldFilePath: "src/a.ts",
      newFilePath: "src/a.ts",
      type: "M",
      fromHash: PARENT,
      revealLine: 7
    });
  });

  it("shows the file under its name before a rename on the left", () => {
    const renamed = line({ filename: "src/b.ts", previous: { sha: PARENT, filename: "old/a.ts" } });
    expect(lineChangeDiff(lineChangeOf("/repo", renamed))).toEqual({
      repo: "/repo",
      commitHash: SHA,
      oldFilePath: "old/a.ts",
      newFilePath: "src/b.ts",
      type: "R",
      fromHash: PARENT,
      revealLine: 7
    });
  });

  it("shows the file as added when the commit has no previous — a root commit, say", () => {
    expect(lineChangeDiff(lineChangeOf("/repo", line({ previous: null })))).toEqual({
      repo: "/repo",
      commitHash: SHA,
      oldFilePath: "src/a.ts",
      newFilePath: "src/a.ts",
      type: "A",
      revealLine: 7
    });
  });
});

describe("lineChangeArgs", () => {
  const change = lineChangeOf("/repo", line());

  it("accepts a line change of a known repository, as a command link hands it", () => {
    // A command link's arguments arrive JSON-parsed from the link's query.
    const roundTrip = JSON.parse(JSON.stringify(change));
    expect(lineChangeArgs(roundTrip, REPOS)).toEqual(change);
    const root = lineChangeOf("/repo", line({ previous: null }));
    expect(lineChangeArgs(JSON.parse(JSON.stringify(root)), REPOS)).toEqual(root);
  });

  it("accepts SHA-256 commits", () => {
    const sha256 = lineChangeOf(
      "/repo",
      line({ sha: "c".repeat(64), previous: { sha: "d".repeat(64), filename: "src/a.ts" } })
    );
    expect(lineChangeArgs(sha256, REPOS)).toEqual(sha256);
  });

  it("refuses a repository that isn't known", () => {
    expect(lineChangeArgs({ ...change, repo: "/elsewhere" }, REPOS)).toBeNull();
    expect(lineChangeArgs({ ...change, repo: "/repo/.." }, REPOS)).toBeNull();
  });

  it("refuses anything but a full commit hash", () => {
    expect(lineChangeArgs({ ...change, sha: SHA.slice(0, 8) }, REPOS)).toBeNull();
    expect(lineChangeArgs({ ...change, sha: "HEAD" }, REPOS)).toBeNull();
    expect(lineChangeArgs({ ...change, sha: `${SHA} --output=x` }, REPOS)).toBeNull();
    expect(
      lineChangeArgs({ ...change, previous: { sha: "--all", filename: "src/a.ts" } }, REPOS)
    ).toBeNull();
  });

  it("refuses a path that isn't relative to the repository, or leaves it", () => {
    for (const filename of ["", "/etc/passwd", "C:/x", "C:\\x", "../x", "a/../../x", "a\\..\\x"]) {
      expect(lineChangeArgs({ ...change, filename }, REPOS)).toBeNull();
      expect(lineChangeArgs({ ...change, previous: { sha: PARENT, filename } }, REPOS)).toBeNull();
    }
    expect(lineChangeArgs({ ...change, filename: "a\0b" }, REPOS)).toBeNull();
  });

  it("accepts a name that only looks like a drive, as a file may be called on Linux", () => {
    const odd = { ...change, filename: "c:notes.txt" };
    expect(lineChangeArgs(odd, REPOS)).toEqual(odd);
  });

  it("refuses a line that isn't a positive whole number", () => {
    for (const bad of [0, -1, 1.5, "7", Number.NaN]) {
      expect(lineChangeArgs({ ...change, line: bad }, REPOS)).toBeNull();
    }
  });

  it("refuses anything else a command link could be handed", () => {
    expect(lineChangeArgs(undefined, REPOS)).toBeNull();
    expect(lineChangeArgs(SHA, REPOS)).toBeNull();
    expect(lineChangeArgs([change], REPOS)).toBeNull();
    expect(lineChangeArgs({ ...change, previous: "x" }, REPOS)).toBeNull();
    expect(lineChangeArgs({ ...change, previous: undefined }, REPOS)).toBeNull();
  });

  it("keeps only what it checked", () => {
    expect(lineChangeArgs({ ...change, extra: "x" }, REPOS)).toEqual(change);
  });
});
