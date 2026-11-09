import { describe, expect, it } from "vitest";

import { type BlameEditorState, blameTarget } from "@/extension/blameTarget";

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
