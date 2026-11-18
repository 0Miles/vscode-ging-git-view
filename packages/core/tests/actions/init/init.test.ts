import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { initRepository, NoWorkTreeFolderError } from "@ging/core/backend/actions/init";
import { gitFolderPlace } from "@ging/core/backend/utils/git";
import { createRepoInitCommand } from "@ging/core/extension/repoInitCommand";

import { fakePorts, makeRepo, makeTempDir, rmrf, toRepoPath } from "@ging/core/tests/helpers";

// Initialize Repository (#394), on real git in a temp folder: the action, and
// the command service the desktop host runs it through.

let dirs: string[] = [];
const tempDir = () => {
  const dir = makeTempDir("ngg-init-");
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  dirs.forEach(rmrf);
  dirs = [];
});

/** A client bound to no repository, as the command service hands one over. */
const unbound = () => simpleGit();

/** What git prints for `args` run in `cwd`, trimmed. */
const git = (args: string[], cwd: string) =>
  cp.execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

describe("initRepository", () => {
  it("makes a repository in an empty temp folder and answers its top as git spells it", async () => {
    const folder = tempDir();

    const result = await initRepository(unbound(), folder);

    expect(result).toEqual({ repo: toRepoPath(folder), created: true });
    expect(git(["rev-parse", "--show-toplevel"], folder)).toBe(toRepoPath(folder));
    expect(git(["rev-parse", "--is-bare-repository"], folder)).toBe("false");
  });

  it("makes the folder too, when it is not there yet", async () => {
    const folder = path.join(tempDir(), "new", "project");

    const result = await initRepository(unbound(), folder);

    expect(result).toEqual({ repo: toRepoPath(folder), created: true });
    expect(fs.statSync(path.join(folder, ".git")).isDirectory()).toBe(true);
  });

  it("leaves a folder that already is a repository's top as it was", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const head = git(["rev-parse", "HEAD"], repo);
    const hook = path.join(repo, ".git", "hooks");

    const result = await initRepository(unbound(), repo);

    expect(result).toEqual({ repo: toRepoPath(repo), created: false });
    expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
    // makeRepo inits with no template: re-initialising would have added hooks.
    expect(fs.existsSync(hook)).toBe(false);
  });

  it("gives a folder inside another repository one of its own", async () => {
    const outer = makeRepo();
    dirs.push(outer);
    const inner = path.join(outer, "inner");
    fs.mkdirSync(inner);

    const result = await initRepository(unbound(), inner);

    expect(result).toEqual({ repo: toRepoPath(inner), created: true });
    expect(git(["rev-parse", "--show-toplevel"], inner)).toBe(toRepoPath(inner));
  });
});

describe("a folder with no working tree", () => {
  /** A bare repository, a working tree's `.git` folder, and a folder in it. */
  const noWorkTreeFolders = () => {
    const bare = path.join(tempDir(), "bare.git");
    git(["init", "--bare", "--template=", bare], tempDir());
    const repo = makeRepo();
    dirs.push(repo);
    return { bare, gitDir: path.join(repo, ".git"), inGitDir: path.join(repo, ".git", "refs") };
  };

  it("is told apart from a working tree's top, a folder in one, and none", async () => {
    const { bare, gitDir, inGitDir } = noWorkTreeFolders();
    const top = makeRepo();
    dirs.push(top);
    const inside = path.join(top, "sub");
    fs.mkdirSync(inside);
    const places = await Promise.all(
      [bare, gitDir, inGitDir, top, inside, tempDir(), path.join(tempDir(), "nowhere")].map(
        (folder) => gitFolderPlace(unbound(), folder)
      )
    );

    expect(places).toEqual([
      "noWorkTree",
      "noWorkTree",
      "noWorkTree",
      "workTreeTop",
      "inWorkTree",
      "none",
      "none"
    ]);
  });

  it("gets no repository: neither re-initialized nor one nested in its database", async () => {
    const { bare, gitDir, inGitDir } = noWorkTreeFolders();
    const before = fs.readdirSync(inGitDir).toSorted();

    const failures = await Promise.all(
      [bare, gitDir, inGitDir].map((folder) => initRepository(unbound(), folder).catch((e) => e))
    );

    expect(failures.map((e) => e instanceof NoWorkTreeFolderError)).toEqual([true, true, true]);
    expect(fs.readdirSync(inGitDir).toSorted()).toEqual(before);
    expect(fs.existsSync(path.join(inGitDir, ".git"))).toBe(false);
  });

  it("is said in the app's words by the command service, not git's", async () => {
    const { bare } = noWorkTreeFolders();
    const { ports, calls } = fakePorts();
    const command = createRepoInitCommand({
      prompts: ports.prompts,
      l10n: ports.l10n,
      gitClientFor: () => unbound()
    });

    expect(await command.initRepo(bare)).toBeUndefined();
    expect(calls).toEqual([["showError", `init.unableTo: init.noWorkTree|${bare}`]]);
  });
});

describe("the Initialize Repository command service", () => {
  it("answers the repository it made", async () => {
    const { ports, calls } = fakePorts();
    const folder = tempDir();
    const command = createRepoInitCommand({
      prompts: ports.prompts,
      l10n: ports.l10n,
      gitClientFor: () => unbound()
    });

    expect(await command.initRepo(folder)).toEqual({ repo: toRepoPath(folder), created: true });
    expect(calls).toEqual([]);
  });

  it("says why, and answers nothing, when git cannot make one", async () => {
    const { ports, calls } = fakePorts();
    // A file where the folder would be: git can make no repository there.
    const file = path.join(tempDir(), "a-file");
    fs.writeFileSync(file, "x");
    const command = createRepoInitCommand({
      prompts: ports.prompts,
      l10n: ports.l10n,
      gitClientFor: () => unbound()
    });

    expect(await command.initRepo(file)).toBeUndefined();
    expect(calls).toEqual([["showError", expect.stringMatching(/^init\.unableTo: .+/)]]);
  });
});
