import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { filesWithConflictMarkers } from "@ging/core/backend/queries/conflictMarkers";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

function folder(files: Record<string, string>): string {
  const dir = makeTempDir("ngg-markers-");
  cleanUp.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

describe("filesWithConflictMarkers", () => {
  it("finds the markers git's merge writes, a diff3 base's among them", async () => {
    const dir = folder({
      "merge.txt": "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nb\n",
      "only end.txt": "ours\n>>>>>>> side\n",
      "dir/diff3.txt": "x\n||||||| base\ny\n",
      "bare start.txt": "<<<<<<<\r\nours\r\n",
      "clean.txt": "resolved\n"
    });

    expect(
      await filesWithConflictMarkers(dir, [
        "merge.txt",
        "only end.txt",
        "dir/diff3.txt",
        "bare start.txt",
        "clean.txt"
      ])
    ).toEqual(["merge.txt", "only end.txt", "dir/diff3.txt", "bare start.txt"]);
  });

  it("takes neither a heading's underline nor a marker that is not at the line's start for one", async () => {
    const dir = folder({
      "README.rst": "Title\n=======\n",
      "quoted.md": "Git writes `<<<<<<< HEAD` there.\n",
      "longer.txt": "<<<<<<<< eight\n"
    });

    expect(await filesWithConflictMarkers(dir, ["README.rst", "quoted.md", "longer.txt"])).toEqual(
      []
    );
  });

  it("finds none in a file that is gone, and reads none outside the repository", async () => {
    const outside = folder({ "secret.txt": "<<<<<<< HEAD\n" });
    const dir = folder({});

    expect(
      await filesWithConflictMarkers(dir, [
        "deleted.txt",
        path.relative(dir, path.join(outside, "secret.txt")),
        path.join(outside, "secret.txt")
      ])
    ).toEqual([]);
  });
});
