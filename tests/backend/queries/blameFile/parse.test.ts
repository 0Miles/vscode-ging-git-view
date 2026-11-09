import { describe, expect, it } from "vitest";

import { parseBlamePorcelain } from "@/backend/queries/blameFile";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

// The shape `git blame --porcelain` prints: a commit's details only the first
// time it appears, `filename` after them, and every line's content behind a tab.
const PORCELAIN = [
  `${B} 2 1 2`,
  "author Bea",
  "author-mail <bea@example.com>",
  "author-time 1700000000",
  "author-tz +0800",
  "committer Bea",
  "committer-mail <bea@example.com>",
  "committer-time 1700000000",
  "committer-tz +0800",
  "summary Rename a.txt and tweak it",
  `previous ${A} a.txt`,
  "filename b.txt",
  "\tfirst",
  `${B} 3 2`,
  "\tsecond",
  `${A} 1 3 1`,
  "author Al",
  "author-mail <al@example.com>",
  "author-time 1600000000",
  "author-tz +0000",
  "committer Al",
  "committer-mail <al@example.com>",
  "committer-time 1600000000",
  "committer-tz +0000",
  "summary init",
  "boundary",
  "filename a.txt",
  "\tthird",
  `${ZERO} 4 4 1`,
  "author Not Committed Yet",
  "author-mail <not.committed.yet>",
  "author-time 1800000000",
  "author-tz +0000",
  "committer Not Committed Yet",
  "committer-mail <not.committed.yet>",
  "committer-time 1800000000",
  "committer-tz +0000",
  "summary Version of b.txt from b.txt",
  `previous ${B} b.txt`,
  "filename b.txt",
  "\t\tindented with a tab",
  ""
].join("\n");

describe("parseBlamePorcelain", () => {
  const lines = parseBlamePorcelain(PORCELAIN);

  it("yields one entry per final line, in order", () => {
    expect(lines).toHaveLength(4);
  });

  it("carries a commit's details onto the later lines that only repeat its SHA", () => {
    expect(lines[1]).toEqual({
      sha: B,
      uncommitted: false,
      authorName: "Bea",
      authorEmail: "bea@example.com",
      authorTime: 1700000000,
      summary: "Rename a.txt and tweak it",
      originalLine: 3,
      filename: "b.txt",
      previous: { sha: A, filename: "a.txt" }
    });
  });

  it("has no previous for a root commit, and keeps its own filename", () => {
    expect(lines[2]).toMatchObject({ sha: A, originalLine: 1, filename: "a.txt", previous: null });
  });

  it("marks the all-zero SHA as uncommitted", () => {
    expect(lines[0].uncommitted).toBe(false);
    expect(lines[3]).toMatchObject({ sha: ZERO, uncommitted: true, originalLine: 4 });
  });

  it("returns nothing for empty output", () => {
    expect(parseBlamePorcelain("")).toEqual([]);
  });

  // git quotes a path holding a double quote, a backslash or a control
  // character (and, under core.quotePath, any non-ASCII one) in `filename` and
  // `previous` both; the lookups that follow need the real path.
  it("unquotes the paths git quotes", () => {
    const quoted = [
      `${B} 1 1 1`,
      "author Bea",
      "author-mail <bea@example.com>",
      "author-time 1700000000",
      "summary s",
      `previous ${A} "old\\"name.txt"`,
      'filename "tab\\there.txt"',
      "\tline"
    ].join("\n");
    expect(parseBlamePorcelain(quoted)[0]).toMatchObject({
      filename: "tab\there.txt",
      previous: { sha: A, filename: 'old"name.txt' }
    });
  });
});
