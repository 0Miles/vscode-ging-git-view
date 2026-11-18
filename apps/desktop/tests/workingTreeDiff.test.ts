import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { createWorkingTreeService } from "@ging/core/extension/workingTreeService";
import type { L10nArg } from "@ging/core/host/ports";
import { createShowDiff, type HunkRead } from "@ging/desktop/diffViewer";
import { createWorkingTreeDiffs } from "@ging/desktop/workingTreeDiff";
import type { ShowDiffMessage } from "@ging/webview/desktop/diff/protocol";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

// A working tree file's diff, opened from the panel (#460), and its hunks
// staged and unstaged from the diff viewer (#406): real git, the real working
// tree service and diff reader, the page's messages recorded.

const l10n = { t: (key: string, ...args: L10nArg[]) => `<${[key, ...args].join(" ")}>` };

function setUp() {
  const repo = makeRepo();
  onTestFinished(() => rmrf(repo));
  const client = gitClientFactory(repo, "git");
  const mutations: string[] = [];
  const service = createWorkingTreeService({
    git: () => client.getInstance(),
    diffRun: () => ({ gitPath: "git", repoPath: repo }),
    repo: () => repo,
    signCommits: () => false,
    runRepoMutation: async (_on, work) => {
      mutations.push("mutation");
      await work();
    }
  });
  const posted: ShowDiffMessage[] = [];
  const showDiff = createShowDiff({
    gitPath: () => "git",
    fileEncoding: () => "utf8",
    l10n,
    repoRoot: () => repo,
    post: (message) => {
      posted.push(message);
      return true;
    }
  });
  const diffs = createWorkingTreeDiffs({ service, showDiff, l10n, repo: () => repo });
  return { repo, posted, diffs, mutations, last: () => posted.at(-1)! };
}

const numbered = (change: (n: number) => string = String) =>
  Array.from({ length: 20 }, (_, i) => change(i + 1)).join("\n") + "\n";
const EDITED = numbered((n) => (n === 2 ? "two" : n === 19 ? "nineteen" : String(n)));

/** `file` committed as twenty numbered lines, then edited at lines 2 and 19:
 *  two hunks. */
function twoHunks(repo: string, file = "n.txt") {
  fs.writeFileSync(path.join(repo, file), numbered());
  git(["add", file], repo);
  git(["commit", "-qm", file], repo);
  fs.writeFileSync(path.join(repo, file), EDITED);
}

const indexed = (repo: string, file: string) =>
  cp.execFileSync("git", ["show", `:0:${file}`], { cwd: repo }).toString();

describe("a working tree file's diff (#460)", () => {
  it("shows an unstaged change as the index against the working tree, its hunks to stage", async () => {
    const { repo, posted, diffs } = setUp();
    twoHunks(repo);

    expect(
      await diffs.show({ command: "workingTreeShowDiff", path: "n.txt", area: "unstaged" })
    ).toBe(true);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      title: "<desktop.diff.workingTree n.txt>",
      original: { path: "n.txt", content: numbered() },
      modified: { path: "n.txt", content: EDITED },
      hunks: {
        path: "n.txt",
        area: "unstaged",
        label: "<desktop.diff.stageHunk>",
        name: "<desktop.diff.hunkName {0} {1} {2}>",
        keyboard: "<desktop.diff.stageKeyboard>",
        hunks: [
          { original: { start: 1, count: 5 }, modified: { start: 1, count: 5 } },
          { original: { start: 16, count: 5 }, modified: { start: 16, count: 5 } }
        ]
      }
    });
    expect(posted[0].said).toBeUndefined();
  });

  it("shows a staged change as HEAD against the index, its hunks to unstage", async () => {
    const { repo, posted, diffs } = setUp();
    twoHunks(repo);
    git(["add", "n.txt"], repo);
    fs.writeFileSync(path.join(repo, "n.txt"), "not this\n");

    await diffs.show({ command: "workingTreeShowDiff", path: "n.txt", area: "staged" });

    expect(posted[0]).toMatchObject({
      title: "<desktop.diff.index n.txt>",
      original: { content: numbered() },
      modified: { content: EDITED },
      hunks: { area: "staged", label: "<desktop.diff.unstageHunk>" }
    });
  });

  it("shows a staged rename from HEAD's old path, and offers it whole", async () => {
    const { repo, posted, diffs } = setUp();
    twoHunks(repo, "old.txt");
    git(["checkout", "--", "old.txt"], repo);
    git(["mv", "old.txt", "new.txt"], repo);

    await diffs.show({
      command: "workingTreeShowDiff",
      path: "new.txt",
      oldPath: "old.txt",
      area: "staged"
    });

    expect(posted[0]).toMatchObject({
      title: "<desktop.diff.index old.txt → new.txt>",
      original: { path: "old.txt", content: numbered() },
      modified: { path: "new.txt", content: numbered() },
      said: "<desktop.diff.wholeFile>"
    });
    expect(posted[0].hunks).toBeUndefined();
  });

  it("shows what is staged on a branch with no commit yet against nothing", async () => {
    const { repo, posted, diffs } = setUp();
    git(["checkout", "-q", "--orphan", "fresh"], repo);

    await diffs.show({ command: "workingTreeShowDiff", path: "f", area: "staged" });

    expect(posted[0]).toMatchObject({
      original: { path: "f", content: "" },
      modified: { path: "f", content: "x" },
      said: "<desktop.diff.wholeFile>"
    });
  });

  it("shows an untracked file against nothing, with no hunk to stage", async () => {
    const { repo, posted, diffs } = setUp();
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n");

    await diffs.show({ command: "workingTreeShowDiff", path: "new.txt", area: "unstaged" });

    expect(posted[0]).toMatchObject({
      original: { content: "" },
      modified: { content: "new\n" }
    });
    expect(posted[0].hunks).toBeUndefined();
  });

  it("offers no hunk of a file with a carriage return that ends no line", async () => {
    const { repo, posted, diffs } = setUp();
    fs.writeFileSync(
      path.join(repo, "cr.txt"),
      numbered((n) => (n === 5 ? "a\rb" : String(n)))
    );
    git(["add", "cr.txt"], repo);
    fs.writeFileSync(
      path.join(repo, "cr.txt"),
      numbered((n) => (n === 5 ? "a\rb" : n === 19 ? "x" : String(n)))
    );

    await diffs.show({ command: "workingTreeShowDiff", path: "cr.txt", area: "unstaged" });

    expect(posted[0].hunks).toBeUndefined();
    expect(posted[0].said).toBe("<desktop.diff.noHunks>");
  });
});

describe("a hunk staged or unstaged from the diff viewer (#406)", () => {
  it("stages the one hunk, and shows the diff anew where it was, without it", async () => {
    const { repo, posted, diffs, mutations } = setUp();
    twoHunks(repo);
    await diffs.show({ command: "workingTreeShowDiff", path: "n.txt", area: "unstaged" });
    const token = posted[0].hunks!.token;

    await diffs.hunk({
      command: "diffHunk",
      path: "n.txt",
      area: "unstaged",
      token,
      hunk: 1,
      asked: 7
    });

    expect(mutations).toEqual(["mutation"]);
    expect(indexed(repo, "n.txt")).toBe(numbered((n) => (n === 19 ? "nineteen" : String(n))));
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      title: "<desktop.diff.workingTree n.txt>",
      revealLine: 16,
      answers: 7,
      original: { content: numbered((n) => (n === 19 ? "nineteen" : String(n))) },
      hunks: { hunks: [{ original: { start: 1, count: 5 } }] }
    });
    expect(posted[1].said).toBeUndefined();
  });

  it("unstages the one hunk of what is staged", async () => {
    const { repo, posted, diffs } = setUp();
    twoHunks(repo);
    git(["add", "n.txt"], repo);
    await diffs.show({ command: "workingTreeShowDiff", path: "n.txt", area: "staged" });

    await diffs.hunk({
      command: "diffHunk",
      path: "n.txt",
      area: "staged",
      token: posted[0].hunks!.token,
      hunk: 0,
      asked: 1
    });

    expect(indexed(repo, "n.txt")).toBe(numbered((n) => (n === 19 ? "nineteen" : String(n))));
    expect(posted[1].hunks?.hunks).toHaveLength(1);
  });

  it("applies nothing once the file changed since it was shown, and shows it as it is now", async () => {
    const { repo, posted, diffs, mutations } = setUp();
    twoHunks(repo);
    await diffs.show({ command: "workingTreeShowDiff", path: "n.txt", area: "unstaged" });
    fs.writeFileSync(path.join(repo, "n.txt"), "zero\n" + EDITED);

    await diffs.hunk({
      command: "diffHunk",
      path: "n.txt",
      area: "unstaged",
      token: posted[0].hunks!.token,
      hunk: 1,
      asked: 1
    });

    expect(mutations).toEqual([]);
    expect(indexed(repo, "n.txt")).toBe(numbered());
    expect(posted[1]).toMatchObject({
      said: "<desktop.diff.stale>",
      modified: { content: "zero\n" + EDITED }
    });
    expect(posted[1].hunks?.token).not.toBe(posted[0].hunks!.token);
  });
});

/** Hunk reads answering `reads`, one per read. */
function reader(reads: HunkRead[]) {
  return async () => reads.shift()!;
}
/** One hunk, of the diff `token` names. */
const hunks = (token: string): HunkRead => ({
  hunks: {
    path: "f",
    area: "unstaged",
    token,
    label: "Stage Hunk",
    name: "{0}: lines {1} to {2}",
    keyboard: "Press Shift+F10",
    hunks: [{ original: { start: 1, count: 1 }, modified: { start: 1, count: 1 } }]
  }
});

describe("hunks offered on a diff (#406)", () => {
  it("offers none when the diff changed between the reads around its text", async () => {
    const { repo, posted } = setUp();
    const showDiff = createShowDiff({
      gitPath: () => "git",
      fileEncoding: () => "utf8",
      l10n,
      repoRoot: () => repo,
      post: (m) => posted.push(m) > 0
    });
    const request = {
      title: "t",
      original: { revision: { repo, filePath: "f", commit: ":0" } },
      modified: { workingFile: path.join(repo, "f"), repo }
    };

    await showDiff({ ...request, hunks: reader([hunks("a"), hunks("b")]) });
    await showDiff({ ...request, hunks: reader([hunks("a"), hunks("a")]) });

    expect(posted[0].hunks).toBeUndefined();
    expect(posted[0].said).toBe("<desktop.diff.changing>");
    expect(posted[1].hunks?.token).toBe("a");
  });
});
