import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Git kept away from the developer's own configuration (ADR-0032): no system
 * config, and a home of its own whose global config is empty. Given to the
 * fixture's git and to the app's, so neither signs, hooks or rewrites line
 * ends the way someone's ~/.gitconfig says.
 */
export function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".gitconfig"), "");
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    USERPROFILE: home,
    // Nothing configured, so nobody is asked for anything either.
    GIT_TERMINAL_PROMPT: "0"
  };
}

/** What the fixture repository holds, newest commit first. */
export type FixtureRepo = { path: string; commits: { hash: string; subject: string }[] };

/**
 * A repository made for one test, in its own temporary folder: `main` with
 * three commits, and a branch `feature` off the second carrying a fourth. The
 * dates are fixed so the order is the same on every machine.
 */
export function makeFixtureRepo(env: NodeJS.ProcessEnv): FixtureRepo {
  // Spelled the long way: os.tmpdir() can be an 8.3 name on Windows.
  const repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "ging-e2e-repo-")));
  let clock = 1_700_000_000;
  const git = (...args: string[]) => {
    clock += 60;
    const date = `${clock} +0000`;
    return execFileSync("git", args, {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        GIT_AUTHOR_NAME: "Alice",
        GIT_AUTHOR_EMAIL: "alice@example.com",
        GIT_COMMITTER_NAME: "Alice",
        GIT_COMMITTER_EMAIL: "alice@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      }
    })
      .toString()
      .trim();
  };
  const commit = (subject: string) => {
    writeFileSync(path.join(repo, "file.txt"), `${subject}\n`);
    git("add", "file.txt");
    git("commit", "-m", subject);
    return { hash: git("rev-parse", "HEAD"), subject };
  };

  git("init", "--template=", "-b", "main");
  git("config", "core.autocrlf", "false");
  const first = commit("First commit");
  const second = commit("Second commit");
  git("checkout", "-b", "feature");
  const feature = commit("Feature commit");
  git("checkout", "main");
  const third = commit("Third commit");
  return { path: repo, commits: [third, feature, second, first] };
}
