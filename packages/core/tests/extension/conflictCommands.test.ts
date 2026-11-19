import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { createConflictCommands } from "@ging/core/extension/conflictCommands";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";

import {
  fakePorts,
  git,
  makeRepo,
  makeTempDir,
  recordingRunRepoMutation,
  rmrf
} from "@ging/core/tests/helpers";

// A conflict as the desktop host works it (#410): the user's merge tool run on
// real git, judged by the working tree after it, and the question before a
// file still holding markers is marked resolved. No tool here has a window:
// each is a command in the repository's own config.

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

/** A merge of `side` stopped on a conflict in each of `files`, with no
 *  system or global git config: no merge tool but the repository's own. */
function setUp(...files: string[]) {
  const repo = makeRepo();
  const home = makeTempDir("ngg-home-");
  cleanUp.push(repo, home);
  const write = (text: string) => {
    for (const file of files) fs.writeFileSync(path.join(repo, file), `${text}\n`);
  };
  write("base");
  git(["add", "."], repo);
  git(["commit", "-qm", "base"], repo);
  git(["checkout", "-q", "-b", "side"], repo);
  write("side");
  git(["commit", "-qam", "side"], repo);
  git(["checkout", "-q", "main"], repo);
  write("main");
  git(["commit", "-qam", "main"], repo);
  expect(cp.spawnSync("git", ["merge", "side"], { cwd: repo }).status).not.toBe(0);

  const gitEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config")
  };
  const client = gitClientFactory(repo, "git", undefined, gitEnv);
  const { ports, calls, answers } = fakePorts();
  const conflicts = createConflictCommands({
    prompts: ports.prompts,
    l10n: ports.l10n,
    logger: { log: () => {} },
    git: () => client.getInstance(),
    mergeToolRun: () => ({ gitPath: "git", repoPath: repo, gitEnv }),
    repo: () => repo,
    runRepoMutation: recordingRunRepoMutation(calls)
  });
  const unmerged = () =>
    cp
      .execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repo })
      .toString()
      .split("\n")
      .filter((line) => line !== "");
  return { repo, conflicts, calls, answers, unmerged };
}

/** A "tool" git runs as `cmd`, its exit code trusted. */
function tool(repo: string, name: string, cmd: string) {
  git(["config", `mergetool.${name}.cmd`, cmd], repo);
  git(["config", `mergetool.${name}.trustExitCode`, "true"], repo);
}

describe("mergeTool once its host is gone (#450)", () => {
  it("says nothing of the change refused after the tool, and logs it once", async () => {
    const { repo } = setUp("a.txt");
    tool(repo, "theirs", 'cp "$REMOTE" "$MERGED"');
    git(["config", "merge.tool", "theirs"], repo);
    const { ports, calls } = fakePorts();
    const logged: string[] = [];
    const disposed = new AbortController();
    const client = gitClientFactory(repo, "git");
    const conflicts = createConflictCommands({
      prompts: ports.prompts,
      l10n: ports.l10n,
      logger: { log: (line) => logged.push(line) },
      git: () => client.getInstance(),
      mergeToolRun: () => {
        // The Tab closed while the tool is open: the change after it is refused.
        disposed.abort();
        return { gitPath: "git", repoPath: repo };
      },
      repo: () => repo,
      runRepoMutation: createRunRepoMutation({
        watcher: () => undefined,
        afterMutation: () => {},
        signal: disposed.signal
      })
    });

    await conflicts.mergeTool("a.txt");

    expect(calls.filter(([name]) => String(name).startsWith("show"))).toEqual([]);
    expect(logged.filter((line) => line.includes("aborted"))).toEqual([
      "mergeTool: repo mutation: aborted"
    ]);
  });
});

describe("mergeTool", () => {
  it("runs the configured tool, says nothing once the file is resolved, and refreshes after", async () => {
    const { repo, conflicts, calls, unmerged } = setUp("a.txt", "b.txt");
    tool(repo, "theirs", 'cp "$REMOTE" "$MERGED"');
    git(["config", "merge.tool", "theirs"], repo);

    await conflicts.mergeTool("a.txt");

    expect(unmerged()).toEqual(["b.txt"]);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("side\n");
    expect(calls).toEqual([
      ["runRepoMutation", repo],
      ["runRepoMutation done", repo]
    ]);
  });

  it("warns when the tool exits with the file still in conflict", async () => {
    const { repo, conflicts, calls, unmerged } = setUp("a.txt");
    tool(repo, "giving-up", "false");
    git(["config", "merge.guitool", "giving-up"], repo);

    await conflicts.mergeTool("a.txt");

    expect(unmerged()).toEqual(["a.txt"]);
    expect(calls.at(-1)).toEqual(["showWarning", "mergeTool.unresolved|a.txt|giving-up"]);
  });

  it("says how to configure one when none is, and runs no tool: git would guess", async () => {
    const { repo, conflicts, calls, unmerged } = setUp("a.txt");

    await conflicts.mergeTool("a.txt");

    expect(calls).toEqual([["showError", "mergeTool.notConfigured"]]);
    expect(unmerged()).toEqual(["a.txt"]);
    // git mergetool, had it run, would have left its backup.
    expect(fs.existsSync(path.join(repo, "a.txt.orig"))).toBe(false);
  });

  it("says a file in no conflict has none to resolve", async () => {
    const { repo, conflicts, calls } = setUp("a.txt");
    tool(repo, "theirs", 'cp "$REMOTE" "$MERGED"');
    git(["config", "merge.tool", "theirs"], repo);

    await conflicts.mergeTool("f");

    expect(calls).toEqual([["showInformation", "mergeTool.notConflicted|f"]]);
  });

  it("does not hand git mergetool a name it would read as a pattern", async () => {
    const { repo, conflicts, calls, unmerged } = setUp("[ab].txt", "a.txt");
    tool(repo, "theirs", 'cp "$REMOTE" "$MERGED"');
    git(["config", "merge.tool", "theirs"], repo);

    await conflicts.mergeTool("[ab].txt");

    expect(calls).toEqual([["showError", "mergeTool.cannotName|[ab].txt"]]);
    expect(unmerged()).toEqual(["[ab].txt", "a.txt"]);
  });

  it("opens one tool at a time: a second file waits for the first to close", async () => {
    const { repo, conflicts, calls, unmerged } = setUp("a.txt", "b.txt");
    tool(repo, "theirs", 'cp "$REMOTE" "$MERGED"');
    git(["config", "merge.tool", "theirs"], repo);

    const first = conflicts.mergeTool("a.txt");
    await conflicts.mergeTool("b.txt");
    await first;

    expect(calls[0]).toEqual(["showInformation", "mergeTool.busy|a.txt"]);
    expect(unmerged()).toEqual(["b.txt"]);
    // The first closed: the next one opens.
    await conflicts.mergeTool("b.txt");
    expect(unmerged()).toEqual([]);
  });
});

describe("confirmResolve", () => {
  it("goes on without asking when no conflict marker is left", async () => {
    const { repo, conflicts, calls } = setUp("a.txt");
    fs.writeFileSync(path.join(repo, "a.txt"), "resolved\n");

    expect(await conflicts.confirmResolve(["a.txt"])).toBe(true);
    expect(calls).toEqual([]);
  });

  it("asks first while markers remain, and goes on only when told to", async () => {
    const { conflicts, calls, answers } = setUp("a.txt");
    const asked = [
      "choose",
      "conflict.markersRemain|a.txt",
      { detail: undefined, actions: ["conflict.markResolvedAnyway"] }
    ];

    // Dismissed.
    expect(await conflicts.confirmResolve(["a.txt"])).toBe(false);
    answers.choose = "conflict.markResolvedAnyway";
    expect(await conflicts.confirmResolve(["a.txt"])).toBe(true);

    expect(calls).toEqual([asked, asked]);
  });

  it("names every file still marked when there are several", async () => {
    const { repo, conflicts, calls } = setUp("a.txt", "b.txt", "c.txt");
    fs.writeFileSync(path.join(repo, "c.txt"), "resolved\n");

    expect(await conflicts.confirmResolve(["a.txt", "b.txt", "c.txt"])).toBe(false);
    expect(calls).toEqual([
      [
        "choose",
        "conflict.markersRemainMany|2",
        { detail: "a.txt\nb.txt", actions: ["conflict.markResolvedAnyway"] }
      ]
    ]);
  });
});
