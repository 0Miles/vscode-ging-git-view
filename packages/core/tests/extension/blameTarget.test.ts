import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type BlameEditorState, blameTarget } from "@ging/core/extension/blameTarget";

import { makeTempDir, rmrf, toRepoPath } from "@ging/core/tests/helpers";

const REPOS = ["/work/app", "/work/app/sub"];

function editor(overrides: Partial<BlameEditorState> = {}): BlameEditorState {
  return {
    scheme: "file",
    filePath: "/work/app/src/a.ts",
    selections: [{ startLine: 4, endLine: 4 }],
    cursorLine: 4,
    ...overrides
  };
}

describe("blameTarget", () => {
  it("annotates the cursor line, blamed in the file's known repository", () => {
    expect(blameTarget(editor(), REPOS)).toEqual({
      line: 4,
      repo: "/work/app",
      filePath: "src/a.ts"
    });
  });

  it("blames a nested repository's file in that repository", () => {
    expect(blameTarget(editor({ filePath: "/work/app/sub/b.ts" }), REPOS)).toMatchObject({
      repo: "/work/app/sub",
      filePath: "b.ts"
    });
  });

  it("shows nothing for a file outside every known repository", () => {
    expect(blameTarget(editor({ filePath: "/elsewhere/a.ts" }), REPOS)).toBeNull();
  });

  it("shows nothing while a selection spans lines", () => {
    expect(
      blameTarget(editor({ selections: [{ startLine: 4, endLine: 6 }], cursorLine: 6 }), REPOS)
    ).toBeNull();
  });

  it("shows nothing when any of several selections spans lines", () => {
    const selections = [
      { startLine: 4, endLine: 4 },
      { startLine: 8, endLine: 9 }
    ];
    expect(blameTarget(editor({ selections }), REPOS)).toBeNull();
  });

  it("annotates a single-line selection's cursor line", () => {
    expect(blameTarget(editor({ selections: [{ startLine: 4, endLine: 4 }] }), REPOS)?.line).toBe(
      4
    );
  });

  it("shows nothing for a document that is not a file on disk", () => {
    expect(blameTarget(editor({ scheme: "untitled" }), REPOS)).toBeNull();
    expect(blameTarget(editor({ scheme: "git" }), REPOS)).toBeNull();
  });
});

// One repository, two spellings: the workspace's (W, the known repository) and
// git's (G). A file opened under either is blamed in W, by the path git knows
// it by (#435).
describe("blameTarget (real file system)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmrf(d);
  });

  /** A folder holding `src/a.ts`, spelled the way git reports it. */
  function makeRepoDir(): { parent: string; repo: string } {
    const parent = makeTempDir("ging blame target ");
    dirs.push(parent);
    const repo = path.join(parent, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "x\n");
    return { parent, repo };
  }

  it("blames a file under either spelling in the repo known through a junction or symlink", () => {
    const { parent, repo } = makeRepoDir();
    const link = path.join(parent, "link");
    fs.symlinkSync(repo, link, "junction");
    const w = toRepoPath(link);
    const g = toRepoPath(repo);
    const expected = { line: 4, repo: w, filePath: "src/a.ts" };

    expect(blameTarget(editor({ filePath: `${w}/src/a.ts` }), [w])).toEqual(expected);
    expect(blameTarget(editor({ filePath: `${g}/src/a.ts` }), [w])).toEqual(expected);
  });

  it("blames a file under either spelling in the repo known in another letter case, on Windows", (ctx) => {
    if (process.platform !== "win32") ctx.skip("paths differing in case are different paths");
    const { repo } = makeRepoDir();
    const g = toRepoPath(repo);
    const w = g.toUpperCase();
    const expected = { line: 4, repo: w, filePath: "src/a.ts" };

    expect(blameTarget(editor({ filePath: `${w}/src/a.ts` }), [w])).toEqual(expected);
    expect(blameTarget(editor({ filePath: `${g}/src/a.ts` }), [w])).toEqual(expected);
  });

  it("shows nothing for a file that does not exist outside every known repository", () => {
    const { parent, repo } = makeRepoDir();

    expect(
      blameTarget(editor({ filePath: toRepoPath(path.join(parent, "gone", "a.ts")) }), [
        toRepoPath(repo)
      ])
    ).toBeNull();
  });
});
