import type { SimpleGit } from "simple-git";

import type { GitRunOptions } from "@ging/core/backend/gitRun";
import { spawnGit } from "@ging/core/backend/gitSpawn";

/** Where `git mergetool` runs: the repository's top, with the client's git and
 *  environment. No deadline: the tool is the user's, open as long as they
 *  work in it. */
export type MergeToolRun = Pick<GitRunOptions, "gitPath" | "repoPath" | "onCommand" | "gitEnv">;

/** What one `git mergetool` run came to. Whether the conflict is resolved is
 *  not read off it: see ADR-0030, and `unmergedFiles` after it. */
export type MergeToolOutcome = { exitCode: number | null; output: string };

async function configValue(git: SimpleGit, key: string): Promise<string | null> {
  // `--get` of a key that is not set exits 1 saying nothing, which simple-git
  // resolves with no output. What it rejects is git failing: not "unset".
  const value = (await git.raw(["config", "--get", key])).trim();
  return value === "" ? null : value;
}

/**
 * The merge tool the user configured, or `null` with none: `merge.guitool`,
 * falling back to `merge.tool`, as `git mergetool --gui` resolves it. The GUI
 * one first, because the app has no terminal for a terminal tool to run in.
 * Never a guess: `git mergetool` with no tool configured picks one of its
 * own off a list, which is a program the user never chose.
 */
export async function configuredMergeTool(git: SimpleGit): Promise<string | null> {
  return (await configValue(git, "merge.guitool")) ?? (await configValue(git, "merge.tool"));
}

/**
 * Whether `file` can be handed to `git mergetool` by name. It takes its paths
 * as pathspecs and honours neither `--literal-pathspecs` nor `:(literal)`
 * (measured on git 2.40.1): `[ab].txt` merges `a.txt`, and on Windows a
 * backslash cannot escape the bracket. So a name pathspec magic would read —
 * a wildcard, a backslash, a leading colon — is not handed over at all.
 */
export function mergeToolCanName(file: string): boolean {
  return !/[*?[\\]/.test(file) && !file.startsWith(":");
}

/**
 * Run the user's merge tool `tool` on the conflicted `file`, repository-
 * relative: `git mergetool --no-prompt --tool=<tool> -- <file>`, its arguments
 * an array and no shell between (`spawnGit`). Resolves once the tool has
 * closed, however long that takes.
 *
 * Headless: `--no-prompt` drops git's "Hit return to start", and stdin is
 * closed at once, so every other question git asks on it — "Was the merge
 * successful [y/n]?" for a tool whose exit code it does not trust, "(m)odified
 * or (d)eleted?" for a file one side deleted — reads end of input, which git
 * takes as "no". Nothing waits on an answer nobody can give.
 *
 * Rejects only when git could not be started, or `file` cannot be named
 * (`mergeToolCanName`).
 */
export async function runMergeTool(
  run: MergeToolRun,
  tool: string,
  file: string
): Promise<MergeToolOutcome> {
  if (!mergeToolCanName(file)) throw new Error(`git mergetool cannot be given ${file} by name`);
  const result = await spawnGit({
    gitPath: run.gitPath,
    cwd: run.repoPath,
    args: ["mergetool", "--no-prompt", `--tool=${tool}`, "--", file],
    onCommand: run.onCommand,
    gitEnv: run.gitEnv
  });
  if (result.kind === "error") throw result.error;
  if (result.kind !== "ok") throw new Error(`git mergetool did not finish (${result.kind})`);
  return {
    exitCode: result.exitCode,
    output: (result.stdout.toString() + result.stderr).trim()
  };
}
