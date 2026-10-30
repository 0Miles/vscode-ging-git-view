import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export function git(args: string[], cwd: string) {
  cp.execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Run git against a bare repo (which has no working tree) and capture stdout.
 *  Uses an explicit `--git-dir` rather than `{ cwd: <bareRepo> }`, which git
 *  refuses when the user has `safe.bareRepository = explicit` configured. */
export function bareGit(args: string[], gitDir: string): string {
  return cp.execFileSync("git", [`--git-dir=${gitDir}`, ...args], { stdio: "pipe" }).toString();
}

/** Block the thread for `ms`. Only used to space out cleanup retries, where the
 *  test has already finished and there is nothing else to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Drop the read-only bit from every file under `dir`.
 *
 * Git writes loose objects and packfiles with mode 444, which on Windows sets
 * `FILE_ATTRIBUTE_READONLY`, and `DeleteFile` refuses to unlink such a file.
 * Some Node builds clear the attribute for you inside recursive `rm` (Node
 * 24.10 does); the one shipped in VS Code's extension host (Node 24.18) does
 * not, and fails with `EPERM` on `.git/objects/**` every single time. Waiting
 * cannot fix that, so clear the bit before retrying.
 */
function makeWritable(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // already gone, or unreadable — the caller reports the failure
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // chmod would follow it out of the tree
    if (entry.isDirectory()) {
      makeWritable(full);
    } else {
      try {
        fs.chmodSync(full, 0o666);
      } catch {
        // best effort — the retry reports if the directory still will not go
      }
    }
  }
}

/**
 * Remove a temp repo created by a test.
 *
 * Two things break a plain `rmSync` on Windows, and both are handled here:
 *
 * - Read-only git objects, which fail deterministically. See `makeWritable`.
 * - A git child process still holding the directory open for a short while
 *   after its promise resolves, which fails intermittently with `EPERM`/
 *   `EBUSY`. `rmSync`'s own `maxRetries` does not cover this: the error comes
 *   from the initial stat, ahead of Node's retry loop, so it gives up after
 *   0ms. Hence the explicit backoff.
 *
 * A cleanup that never succeeds must not fail the test — the leftovers sit in
 * the OS temp directory.
 */
export function rmrf(dir: string): void {
  // Wait between attempts, then `null` for the final attempt, which reports instead.
  for (const delay of [25, 50, 100, 200, 400, null]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (delay === null) {
        process.emitWarning(`could not remove test dir ${dir}: ${String(err)}`);
        return;
      }
      makeWritable(dir);
      sleepSync(delay);
    }
  }
}

/** Repo paths handed to the backend always use "/" separators (see
 *  `getPathFromUri`), and git reports them that way too. `path.join` yields "\"
 *  on Windows, so normalise before comparing against either. */
export function toRepoPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Settings every test repo carries in its own `.git/config`.
 *
 * Git for Windows defaults `core.autocrlf` to true, which rewrites LF to CRLF on
 * checkout and breaks working-tree assertions. Pin it per repo rather than relying
 * only on the GIT_CONFIG_* override in setup.ts: simple-git's `.env(name, value)`
 * spawns git with *only* those variables, so process.env does not reach it.
 */
const REPO_CONFIG = `[user]
\temail = t@t.com
\tname = T
[commit]
\tgpgsign = false
[tag]
\tgpgsign = false
[core]
\tautocrlf = false
\teol = lf
`;

/**
 * Create a temp repo with one commit on `main`.
 *
 * Keep the git spawns to a minimum. Inside the VS Code extension host on Windows
 * each one costs 100–250ms, and the extension tests called this from a `setup`
 * hook with Mocha's 2000ms budget; the nine spawns this used to take went over
 * it under load (#116), and later the three it takes now did too (#283), so
 * those hooks use `copyRepo` instead. The config is appended to `.git/config`
 * directly instead of one `git config` per key, and `--template=` skips copying
 * the sample hooks, which also keeps the `fs.cpSync` copies small.
 *
 * `init -b` needs git 2.28; setup.ts already relies on GIT_CONFIG_COUNT (2.31).
 */
export function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-test-"));
  git(["init", "--template=", "-b", "main"], dir);
  fs.appendFileSync(path.join(dir, ".git", "config"), REPO_CONFIG);
  fs.writeFileSync(path.join(dir, "f"), "x");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

/**
 * A temp repo copied from `seed` (a `makeRepo()` made once per suite), for hooks
 * whose budget is too tight for three spawns under load. One spawn instead,
 * about a quarter of `makeRepo()`'s time (#283).
 *
 * The copy keeps the seed's commit, so every copy has the same SHA. That is
 * already true of two `makeRepo()`s made in the same second: the commit object
 * holds nothing but a fixed tree, identity and message plus a whole-second
 * timestamp. It is still kept to the extension suites, which only need a
 * directory that is a repo. The backend suites have 30s budgets and nothing to
 * gain, and a seed shared across a vitest worker's files would outlive the suite
 * that made it, with only a process-exit hook left to remove it.
 *
 * The refresh is the one spawn that cannot go. The copied file has a new mtime,
 * so the copied index no longer matches it: `git status` refreshes and never
 * notices, but plumbing that reads the index as is, like `git diff-files`,
 * reports the file modified.
 */
export function copyRepo(seed: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-test-"));
  fs.cpSync(seed, dir, { recursive: true });
  git(["update-index", "-q", "--refresh"], dir);
  return dir;
}

/** Mocha budget for the `suiteSetup` that makes an extension suite's seed: one
 *  `makeRepo()`, which has run to 2.4s on a loaded machine against Mocha's
 *  default 2000ms (#283). Paid once per suite rather than once per test. */
export const SEED_TIMEOUT_MS = 10_000;
