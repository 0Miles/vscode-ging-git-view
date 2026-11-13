import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { ExtensionState } from "@ging/core/extensionState";
import { createDesktopRepoSource } from "@ging/desktop/ports/repoSource";
import { openDesktopStorage } from "@ging/desktop/ports/storage";
import type { GitRepoSet } from "@ging/shared/types";

import { describeRepoSourceContract, type KnownRepos } from "@ging/core/tests/contracts/repoSource";
import { makeRepo, makeTempDir, rmrf, toRepoPath } from "@ging/core/tests/helpers";

/** A desktop repo source over the desktop's own storage, with `known` set up
 *  as real repositories; everything goes when the test finishes. */
function subject(known: KnownRepos) {
  const userData = makeTempDir("ging-desktop-repos-");
  const paths = new Map(Object.keys(known).map((name) => [name, toRepoPath(makeRepo())]));
  onTestFinished(() => [userData, ...paths.values()].forEach(rmrf));

  const extensionState = new ExtensionState(openDesktopStorage(userData));
  extensionState.saveRepos(
    Object.fromEntries(Object.entries(known).map(([name, state]) => [paths.get(name)!, state]))
  );
  const source = createDesktopRepoSource(extensionState, { gitPath: () => "git" });
  const broadcasts: GitRepoSet[] = [];
  source.onDidChangeRepos((repos) => broadcasts.push(repos));
  return {
    source,
    extensionState,
    path: (name: string) => paths.get(name)!,
    remove: (name: string) => rmrf(paths.get(name)!),
    broadcasts: () => broadcasts
  };
}

describeRepoSourceContract("the desktop RepoSource", subject);

describe("the desktop RepoSource", () => {
  it("keeps the set where the next session reads it", async () => {
    const s = subject({ a: { columnWidths: null } });
    s.source.setRepoState(s.path("a"), { columnWidths: [3] });
    expect(s.extensionState.getRepos()).toEqual({ [s.path("a")]: { columnWidths: [3] } });
  });

  it("boots on the current repository when it is a known one", () => {
    const s = subject({ a: { columnWidths: null }, b: { columnWidths: null } });
    s.extensionState.setLastActiveRepo(s.path("b"));
    expect(s.source.getBootRepo()).toBe(s.path("b"));
  });

  it("adds an opened repository, applying the team's shared settings, and broadcasts", () => {
    const s = subject({});
    const repo = toRepoPath(makeRepo());
    onTestFinished(() => rmrf(repo));
    fs.mkdirSync(path.join(repo, ".vscode"));
    fs.writeFileSync(
      path.join(repo, ".vscode", "ging-git-view.json"),
      JSON.stringify({ hiddenRemotes: ["upstream"] })
    );

    s.source.addRepo(repo);

    expect(s.source.getRepos()).toEqual({
      [repo]: { columnWidths: null, hiddenRemotes: ["upstream"] }
    });
    expect(s.broadcasts()).toEqual([s.source.getRepos()]);
  });

  it("leaves a repository it already knows as it is when it is opened again", () => {
    const s = subject({ a: { columnWidths: [7], customName: "Alpha" } });
    s.source.addRepo(s.path("a"));
    expect(s.source.getRepos()[s.path("a")]).toEqual({ columnWidths: [7], customName: "Alpha" });
    expect(s.broadcasts()).toEqual([]);
  });

  it("stops telling a listener once it has let go", () => {
    const s = subject({ a: { columnWidths: null }, b: { columnWidths: null } });
    const heard: GitRepoSet[] = [];
    s.source.onDidChangeRepos((repos) => heard.push(repos)).dispose();
    s.source.dropRepo(s.path("a"));
    expect(heard).toEqual([]);
  });
});
