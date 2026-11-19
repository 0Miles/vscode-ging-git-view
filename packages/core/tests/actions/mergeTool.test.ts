import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  configuredMergeTool,
  type MergeToolRun,
  mergeToolCanName,
  runMergeTool
} from "@ging/core/backend/actions/mergeTool";
import { gitClientFactory } from "@ging/core/backend/gitClient";
import { unmergedFiles } from "@ging/core/backend/queries/unmergedFiles";

import { git, makeRepo, makeTempDir, rmrf } from "@ging/core/tests/helpers";

// `git mergetool` run headless, as the desktop host runs it (#410): real git,
// and a "tool" that is only a command in the repository's config — never a
// program with a window. Each run is a shell script of git's, a second or two
// on Windows.

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

/** No system or global git config, so no merge tool the machine has set. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const home = makeTempDir("ngg-home-");
  cleanUp.push(home);
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config")
  };
}

/** A repository whose merge of `side` stopped on a conflict in each of
 *  `files`: "main" on one side, "side" on the other. */
function conflicted(...files: string[]): string {
  const r = makeRepo();
  cleanUp.push(r);
  const write = (text: string) => {
    for (const file of files) fs.writeFileSync(path.join(r, file), `${text}\n`);
  };
  write("base");
  git(["add", "."], r);
  git(["commit", "-qm", "base"], r);
  git(["checkout", "-q", "-b", "side"], r);
  write("side");
  git(["commit", "-qam", "side"], r);
  git(["checkout", "-q", "main"], r);
  write("main");
  git(["commit", "-qam", "main"], r);
  expect(cp.spawnSync("git", ["merge", "side"], { cwd: r }).status).not.toBe(0);
  return r;
}

/** A "tool" named `name`: `cmd` run by git's own shell, with $LOCAL, $REMOTE,
 *  $BASE and $MERGED set. */
function tool(r: string, name: string, cmd: string, trustExitCode: boolean) {
  git(["config", `mergetool.${name}.cmd`, cmd], r);
  git(["config", `mergetool.${name}.trustExitCode`, String(trustExitCode)], r);
}

const runIn = (r: string, gitEnv = isolatedEnv()): MergeToolRun => ({
  gitPath: "git",
  repoPath: r,
  gitEnv
});
const unmerged = (r: string) => unmergedFiles(simpleGit(r));

describe("configuredMergeTool", () => {
  // A client as the host makes one: its environment is checked by simple-git.
  const clientIn = (r: string) =>
    gitClientFactory(r, "git", undefined, isolatedEnv()).getInstance();

  it("is null with no tool configured: git is never left to guess one", async () => {
    const r = conflicted("f");
    expect(await configuredMergeTool(clientIn(r))).toBeNull();
  });

  it("is merge.tool, or merge.guitool when that is set too", async () => {
    const r = conflicted("f");
    git(["config", "merge.tool", "vimdiff"], r);
    expect(await configuredMergeTool(clientIn(r))).toBe("vimdiff");

    git(["config", "merge.guitool", "meld"], r);
    expect(await configuredMergeTool(clientIn(r))).toBe("meld");
  });
});

/**
 * Budget for the tests that run `git mergetool` once: the conflict
 * `conflicted` builds (eight git commands one after another), then the
 * script's sh, its own git commands and the tool's.
 *
 * Measured with 16 busy loops pinning the CPU on Windows (#476): 39.5–45.4s
 * each, past the backend's 30s default; the test whose name git would read as
 * a pattern, which runs no tool, 6.9s. 30s for the conflict and 30s for the
 * run of the tool, as in conflictCommands.test.ts.
 */
const ONE_MERGETOOL_TIMEOUT_MS = 60_000;

describe("runMergeTool", () => {
  it(
    "runs the tool on the file named, which git stages once it is resolved",
    { timeout: ONE_MERGETOOL_TIMEOUT_MS },
    async () => {
      // Spaces and a `$` taken as written: no shell reads the name on its way.
      const file = "a b $HOME.txt";
      const r = conflicted(file, "other.txt");
      tool(r, "theirs", 'cp "$REMOTE" "$MERGED"', true);

      const outcome = await runMergeTool(runIn(r), "theirs", file);

      expect(outcome.exitCode).toBe(0);
      expect(await unmerged(r)).toEqual(["other.txt"]);
      expect(fs.readFileSync(path.join(r, file), "utf8")).toBe("side\n");
      const staged = cp.execFileSync(
        "git",
        ["diff", "--cached", "--name-only", "--diff-filter=M"],
        {
          cwd: r
        }
      );
      expect(staged.toString()).toBe(`${file}\n`);
    }
  );

  it("runs no command a file's name spells", { timeout: ONE_MERGETOOL_TIMEOUT_MS }, async () => {
    const file = "$(touch pwned) `touch pwned2`.txt";
    const r = conflicted(file);
    tool(r, "theirs", 'cp "$REMOTE" "$MERGED"', true);

    await runMergeTool(runIn(r), "theirs", file);

    expect(await unmerged(r)).toEqual([]);
    expect(fs.existsSync(path.join(r, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(r, "pwned2"))).toBe(false);
  });

  it(
    "leaves the file in conflict when the tool fails",
    { timeout: ONE_MERGETOOL_TIMEOUT_MS },
    async () => {
      const r = conflicted("f");
      tool(r, "failing", "false", true);

      const outcome = await runMergeTool(runIn(r), "failing", "f");

      expect(outcome.exitCode).not.toBe(0);
      expect(await unmerged(r)).toEqual(["f"]);
    }
  );

  it(
    "never waits on git's question for a tool it does not trust: no one is there to answer",
    { timeout: ONE_MERGETOOL_TIMEOUT_MS },
    async () => {
      // Untouched by a tool whose exit code git does not trust, git asks "Was
      // the merge successful [y/n]?" on stdin, which is closed: read as no.
      const r = conflicted("f");
      tool(r, "untrusted", "true", false);

      const outcome = await runMergeTool(runIn(r), "untrusted", "f");

      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toContain("seems unchanged");
      expect(await unmerged(r)).toEqual(["f"]);
    }
  );

  it("hands git mergetool no name it would read as a pattern", async () => {
    // `[ab].txt` as a pathspec matches a.txt: git mergetool would merge that.
    const r = conflicted("[ab].txt", "a.txt");
    tool(r, "theirs", 'cp "$REMOTE" "$MERGED"', true);

    await expect(runMergeTool(runIn(r), "theirs", "[ab].txt")).rejects.toThrow(/by name/);
    expect(await unmerged(r)).toEqual(["[ab].txt", "a.txt"]);
  });
});

describe("mergeToolCanName", () => {
  it("takes a plain name, and none git would read as pathspec magic", () => {
    for (const name of ["f", "dir/a b.txt", "$HOME.txt", "a(1).txt", "x:y"]) {
      expect(mergeToolCanName(name), name).toBe(true);
    }
    for (const name of ["[ab].txt", "*.txt", "a?.txt", "a\\b.txt", ":(top)f"]) {
      expect(mergeToolCanName(name), name).toBe(false);
    }
  });
});
