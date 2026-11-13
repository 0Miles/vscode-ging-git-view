import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { repoToOpen } from "@ging/desktop/repoToOpen";

import { makeRepo, makeTempDir, rmrf, toRepoPath } from "@ging/core/tests/helpers";

// What a launch's `--repo <path>` (or positional path) opens (#388): the
// repository, held to the same test the Current repository is held to
// (`resolveCurrentRepo`) and then asked of git, or nothing — a path that fails
// is never handed to the webview.

const temp = (make: () => string) => {
  const dir = make();
  onTestFinished(() => rmrf(dir));
  return dir;
};

describe("the repository a launch opens", () => {
  it("is the repository at the path, spelled as the graph spells repositories", async () => {
    const repo = temp(makeRepo);
    expect(await repoToOpen(repo, "git")).toEqual({ repo: toRepoPath(repo) });
  });

  it("is the whole repository when the path is a folder inside it", async () => {
    const repo = temp(makeRepo);
    fs.mkdirSync(path.join(repo, "sub"));
    expect(await repoToOpen(path.join(repo, "sub"), "git")).toEqual({ repo: toRepoPath(repo) });
  });

  it("is nothing for a path that does not exist", async () => {
    const parent = temp(() => makeTempDir("ging-open-"));
    const missing = path.join(parent, "missing");
    expect(await repoToOpen(missing, "git")).toEqual({ unusable: missing });
  });

  it("is nothing for a file", async () => {
    const parent = temp(() => makeTempDir("ging-open-"));
    const file = path.join(parent, "file.txt");
    fs.writeFileSync(file, "x");
    expect(await repoToOpen(file, "git")).toEqual({ unusable: file });
  });

  it("is nothing for a folder git does not take for a working tree", async () => {
    const folder = temp(() => makeTempDir("ging-open-"));
    expect(await repoToOpen(folder, "git")).toEqual({ unusable: folder });
  });
});
