import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFileBlameService } from "@ging/core/extension/fileBlameService";
import type { L10n } from "@ging/core/host/ports";

import { git, makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

// A file's blame as the desktop app's blame view shows it (#409): one file
// at a time, annotated and hovered as the inline blame is. Real git, on one
// repository made once: two authors, the user (`t@t.com`, makeRepo's) and
// another, and a change in the working tree.

let repo: string;
let first: string;
let second: string;

function commit(message: string, author: string, unixTime: number) {
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", message, `--author=${author}`, `--date=${unixTime} +0000`], repo);
}

beforeAll(() => {
  repo = makeRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  commit("add a\n\nwith a body", "T <t@t.com>", 1_600_000_000);
  first = rev(repo, "HEAD");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\nthree\n");
  commit("shout two", "Bea <bea@example.com>", 1_700_000_000);
  second = rev(repo, "HEAD");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\nthree\nnot committed\n");
});

afterAll(() => rmrf(repo));

const ENGLISH: Record<string, string> = {
  "blame.you": "You",
  "blame.uncommitted": "Uncommitted changes",
  "blame.hover.changes": "Changes",
  "blame.hover.copyHash": "Copy commit hash",
  "blame.hover.openLineChange": "Open this line's change",
  "blame.hover.locateCommit": "Locate in the GING graph"
};
const l10n: L10n = { t: (key) => ENGLISH[key] ?? key };

/** A day after the second commit. */
const NOW = (1_700_000_000 + 24 * 3600) * 1000;

function service(more: { timeoutMs?: number; maxBytes?: number; log?: string[][] } = {}) {
  return createFileBlameService({
    gitPath: () => "git",
    repo: () => repo,
    l10n,
    locale: "en",
    now: () => NOW,
    links: {
      copyShaCommand: "test.copySha",
      openLineChangeCommand: "test.openLineChange",
      locateCommitCommand: "test.locateCommit",
      icon: (name) => `$(${name})`
    },
    ...(more.log !== undefined && {
      onCommand: (_git: string, args: string[]) => more.log!.push(args)
    }),
    timeoutMs: more.timeoutMs,
    maxBytes: more.maxBytes
  });
}

describe("createFileBlameService (real git)", () => {
  it("annotates each line by its commit, the user's own as theirs, as a commit has the file", async () => {
    const blame = service();

    const answer = await blame.open({ filePath: "a.txt", revision: second });

    expect(answer).toEqual({
      kind: "blamed",
      annotations: {
        repo,
        commits: [
          { sha: first, uncommitted: false, text: "You, 3 years ago • add a" },
          { sha: second, uncommitted: false, text: "Bea, 1 day ago • shout two" }
        ],
        lines: [0, 1, 0]
      }
    });
  });

  it("says the working tree's lines not committed yet are so", async () => {
    const blame = service();

    const answer = await blame.open({ filePath: "a.txt", revision: null });

    expect(answer?.kind === "blamed" && answer.annotations.lines).toEqual([0, 1, 0, 2]);
    expect(answer?.kind === "blamed" && answer.annotations.commits[2]).toEqual({
      sha: "0".repeat(40),
      uncommitted: true,
      text: "You • Uncommitted changes"
    });
  });

  it("says it failed for a file it cannot blame: not in the commit, or too big", async () => {
    expect(await service().open({ filePath: "missing.txt", revision: second })).toEqual({
      kind: "failed"
    });
    expect(await service({ maxBytes: 4 }).open({ filePath: "a.txt", revision: second })).toEqual({
      kind: "failed"
    });
  });

  it("answers nothing for a file opened over, its git stopped, and blames the one after", async () => {
    const blame = service();

    const overtaken = blame.open({ filePath: "a.txt", revision: second });
    const latest = blame.open({ filePath: "a.txt", revision: first });

    expect(await overtaken).toBeNull();
    expect(await latest).toMatchObject({ kind: "blamed", annotations: { lines: [0, 0, 0] } });
  });

  it("answers nothing for a file closed while it was blamed", async () => {
    const blame = service();

    const closed = blame.open({ filePath: "a.txt", revision: second });
    blame.close();

    expect(await closed).toBeNull();
  });

  it("hovers a committed line with its commit's whole message, its hunk and its links", async () => {
    const blame = service();
    await blame.open({ filePath: "a.txt", revision: second });

    const hover = await blame.hover(1);

    expect(hover).toContain("**Bea**");
    expect(hover).toContain("shout two");
    // The commit's hunk holding the line.
    expect(hover).toContain("-two\n+TWO");
    expect(hover).toContain("(command:test.copySha?");
    expect(hover).toContain("(command:test.openLineChange?");
    expect(hover).toContain("(command:test.locateCommit?");
    expect(hover).toContain("$(change)");
    expect(await blame.hover(0)).toContain("with a body");
  });

  it("hovers a line not committed yet with just that, and no line past the file", async () => {
    const blame = service();
    await blame.open({ filePath: "a.txt", revision: null });

    expect(await blame.hover(3)).toBe("Uncommitted changes");
    expect(await blame.hover(4)).toBeNull();
  });

  it("answers no hover for a line asked over, whose lookup was stopped, and the latest in full", async () => {
    const blame = service();
    await blame.open({ filePath: "a.txt", revision: second });

    // Lines 0 and 1 are of different commits: asking for 1 stops 0's lookup.
    const overtaken = blame.hover(0);
    const latest = blame.hover(1);

    expect(await overtaken).toBeNull();
    expect(await latest).toContain("-two\n+TWO");
    // Asked again, it is written in full.
    expect(await blame.hover(0)).toContain("with a body");
  });

  it("hovers nothing once closed", async () => {
    const blame = service();
    await blame.open({ filePath: "a.txt", revision: second });
    blame.close();

    expect(await blame.hover(0)).toBeNull();
  });

  it("takes a link's argument only of the repository it blames in, and a commit only by its hash", async () => {
    const blame = service();
    await blame.open({ filePath: "a.txt", revision: second });
    const change = { repo, sha: second, filename: "a.txt", line: 2, previous: null };

    expect(blame.lineChange(change)).toEqual({
      repo,
      commitHash: second,
      oldFilePath: "a.txt",
      newFilePath: "a.txt",
      type: "A",
      revealLine: 2
    });
    expect(blame.lineChange({ ...change, repo: "/elsewhere" })).toBeNull();
    expect(blame.locate({ repo, sha: second })).toBe(second);
    expect(blame.locate({ repo: "/elsewhere", sha: second })).toBeNull();
    expect(blame.locate({ repo, sha: "HEAD" })).toBeNull();
    expect(blame.copySha(second)).toBe(second);
    expect(blame.copySha("--output=x")).toBeNull();
  });
});
