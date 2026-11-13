import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseForwardedLaunch, parseLaunchArgs } from "@ging/desktop/launchArgs";

const EXE = path.resolve("/opt/ging/ging");
const WORK = path.resolve("/home/me/work");
const REPO = path.resolve("/home/me/work/repo");

/** A packaged build's argv: the executable, then what the user typed. */
const packaged = (...args: string[]) =>
  parseLaunchArgs({ argv: [EXE, ...args], workingDirectory: WORK }, { defaultApp: false });

describe("parseLaunchArgs", () => {
  it("takes the repository from --repo <path>", () => {
    expect(packaged("--repo", REPO)).toEqual({ repo: REPO, ignored: [] });
  });

  it("takes a single positional argument as the repository, relative to the working directory", () => {
    expect(packaged("repo")).toEqual({ repo: REPO, ignored: [] });
  });

  // With the RunAsNode fuse off, git running the askpass helper starts the app
  // itself: the helper's script, then the prompt (#386).
  it("opens nothing for an askpass-shaped launch, and reports every argument", () => {
    const helper = path.resolve("/opt/ging/resources/askpassMain.js");
    const prompt = "Username for 'https://example.com': ";
    expect(packaged(helper, prompt)).toEqual({ repo: null, ignored: [helper, prompt] });
  });

  it("skips the runtime's switches and the app's path in an unpackaged build", () => {
    // How Playwright starts the app: Electron, its inspector switches, then
    // the app directory, then the app's own arguments.
    const electron = path.resolve("/repo/node_modules/electron/dist/electron");
    const app = path.resolve("/repo/apps/desktop");
    const argv = [electron, "--inspect=0", "--remote-debugging-port=0", app, "--repo", REPO];
    expect(parseLaunchArgs({ argv, workingDirectory: WORK }, { defaultApp: true })).toEqual({
      repo: REPO,
      ignored: []
    });
  });

  it("opens nothing for a --repo with no path, and reports it", () => {
    expect(packaged("--repo")).toEqual({ repo: null, ignored: ["--repo"] });
    expect(packaged("--repo", "--verbose")).toEqual({
      repo: null,
      ignored: ["--repo", "--verbose"]
    });
  });

  it("takes no other spelling of --repo", () => {
    expect(packaged("--repo=repo")).toEqual({ repo: null, ignored: ["--repo=repo"] });
  });

  it("opens nothing when two arguments each name a repository, and reports both in order", () => {
    expect(packaged("--repo", REPO, "--x", "other")).toEqual({
      repo: null,
      ignored: ["--repo", REPO, "--x", "other"]
    });
  });

  it("ignores switches it does not know, and still opens the repository", () => {
    expect(packaged("--frobnicate", "--repo", REPO, "--level=3")).toEqual({
      repo: REPO,
      ignored: ["--frobnicate", "--level=3"]
    });
  });
});

describe("parseForwardedLaunch", () => {
  it("reads a later launch's command line from its own working directory", () => {
    const data = { argv: [EXE, "repo", "--frobnicate"], workingDirectory: WORK };
    expect(parseForwardedLaunch(data, { defaultApp: false })).toEqual({
      repo: REPO,
      ignored: ["--frobnicate"]
    });
  });

  it.each([
    ["nothing", undefined],
    ["no command line", { workingDirectory: WORK }],
    ["a command line that is not all strings", { argv: [EXE, 1], workingDirectory: WORK }],
    ["no working directory", { argv: [EXE, "repo"] }]
  ])("reads nothing from %s", (_, data) => {
    expect(parseForwardedLaunch(data, { defaultApp: false })).toBeNull();
  });
});
