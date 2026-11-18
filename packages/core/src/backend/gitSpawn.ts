import * as cp from "node:child_process";

/** Called for every spawned git command (binary + args), for logging. */
export type GitCommandHandler = (command: string, args: string[]) => void;

// Disable coloured output on every command so user git config such as
// color.branch = always can't inject ANSI escapes into the values we parse
// (e.g. branch names in the dropdown). Per-command color.* settings take
// precedence over color.ui, so each parsed command's key is set explicitly.
// log.showSignature is likewise forced off: when a user enables it, git log
// prepends GPG verification lines to each commit, corrupting our parsing.
export const GIT_CONFIG_OVERRIDES = [
  "color.ui=false",
  "color.branch=false",
  "color.diff=false",
  "color.status=false",
  "color.decorate=false",
  "color.log=false",
  "log.showSignature=false"
];

// Environment variables that must NOT be forwarded to the git children we spawn.
// Two groups:
//   1. Vars that simple-git's "block unsafe operations" guard rejects unless a
//      matching unsafe.* flag is enabled (see @simple-git/argv-parser). We only
//      enable allowUnsafeAskPass / allowUnsafeEditor, so any of these inherited
//      from the parent (a shell PAGER, a GIT_CONFIG_COUNT, …) would make
//      simple-git throw on EVERY command. The extension never needs them: it
//      never pages, sets its own askpass/editor, and passes config via -c args.
//   2. Repo-location overrides that would redirect git away from the repoPath we
//      target. We always pin the repo via baseDir/cwd, so an ambient GIT_DIR /
//      GIT_WORK_TREE leaking in from the host must never take effect.
const STRIPPED_GIT_ENV = new Set([
  // (1) rejected by simple-git unless explicitly allowed
  "PAGER",
  "GIT_PAGER",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_EXEC_PATH",
  "PREFIX",
  // (2) repo-location overrides
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_NAMESPACE"
]);

/** A copy of the parent environment with the variables above removed, so each
 *  git child still inherits HOME / PATH / SSH_AUTH_SOCK / locale — without which
 *  git can't locate the user's global config or run credential helpers, and
 *  pushes fail with "Repository not found". simple-git spawns the child with
 *  EXACTLY the object handed to .env() (it does NOT merge with process.env), so
 *  the inheritance has to be reconstructed here. */
function inheritedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (STRIPPED_GIT_ENV.has(upper)) continue;
    // GIT_CONFIG_COUNT's companion GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>.
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper)) continue;
    env[key] = value;
  }
  return env;
}

/** The environment every git child gets: the sanitised parent environment, a
 *  no-op editor, then `gitEnv` (e.g. the GIT_ASKPASS handles) layered on top. */
export function gitChildEnv(gitEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Start from the (sanitised) parent environment so the child keeps
  // HOME/PATH/etc., then layer our own variables on top.
  const childEnv = inheritedGitEnv();
  // The extension can never host an interactive editor, so force every git
  // child to a no-op editor. Without this, commands that would open one
  // (e.g. `merge`/`rebase`/`cherry-pick` `--continue`) hang the child
  // forever. GIT_EDITOR is the portable way to do this (cross-platform,
  // unlike a `core.editor=true` that relies on a `true` binary being on PATH).
  childEnv["GIT_EDITOR"] = "true";
  if (gitEnv !== undefined) {
    for (const [key, value] of Object.entries(gitEnv)) {
      if (value !== undefined) childEnv[key] = value;
    }
  }
  return childEnv;
}

export type GitSpawnOptions = {
  gitPath: string;
  cwd: string;
  args: string[];
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Kill the child (best-effort, see `killTree`) and resolve `timeout` once
   *  it has run this long. */
  timeoutMs?: number;
  /** Kill the child (best-effort, see `killTree`) and resolve `aborted` once
   *  this aborts; nothing is spawned (or logged) if it already has. */
  signal?: AbortSignal;
  onCommand?: GitCommandHandler;
  gitEnv?: NodeJS.ProcessEnv;
  /** Handed each piece of the child's stderr as it comes, decoded, while the
   *  run has not settled: where git reports its progress (`--progress`).
   *  The whole of it is still in the `ok` result. */
  onStderr?: (text: string) => void;
  /** Outside Windows, run git in a process group of its own, so a kill
   *  reaches every process in it — the remote helper git starts for an HTTP
   *  remote (`git-remote-http`) included, which git leaves running when it is
   *  itself killed (ADR-0028's 補記 of 2026-11-17). For a caller on the
   *  network; Windows' `taskkill /T` takes the tree already.
   *
   *  It is Node's `detached`, which outside Windows is `setsid`: a session of
   *  its own as well as a process group, away from any controlling terminal.
   *  Nothing is lost by that: a credential is asked through askpass, never on
   *  a terminal. Detached or not, git goes on running should the app itself
   *  crash: nothing sends it a signal when its parent dies. */
  ownProcessGroup?: boolean;
};

/**
 * Kill `child` and, as far as it can, everything it started — without waiting
 * for any of it to go. On Windows `child.kill()` ends only the direct child —
 * and the `git` found on PATH is usually Git for Windows' `cmd\git.exe`
 * wrapper, so the real git (and any shell it runs) would carry on working.
 * `taskkill /T` takes the tree, but only best-effort; three gaps let a process
 * escape (#361, diagnosed in #343; accepted, not fixed — see ADR-0028):
 *   1. a child born after `taskkill` snapshots the tree;
 *   2. leaves die first, so an MSYS `sh` reads exit 0 and runs its next `&&`;
 *   3. a program an MSYS shell execs has no Windows parent for `/T` to follow.
 * Elsewhere `child.kill()` signals git alone, which does not take down the
 * remote helper it runs for an HTTP remote (measured in #395); a child spawned
 * in a process group of its own (`group`) is killed with all of its group.
 * What git starts otherwise is unmeasured.
 */
function killTree(child: cp.ChildProcess, group = false) {
  // A child that has already exited may have had its PID handed to an
  // unrelated process; `taskkill /T` on it would take that one's tree down.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = cp.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => child.kill());
  } else if (group && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  } else {
    child.kill();
  }
}

export type GitSpawnResult =
  | { kind: "ok"; exitCode: number | null; stdout: Buffer; stderr: string }
  | { kind: "timeout" }
  | {
      kind: "aborted";
      /** Settles once the child is gone and the last of the processes that
       *  share its output have closed it: everything git started that could
       *  still be writing. Not waited for here (ADR-0028); a caller that is to
       *  clean up after git waits for it, as long as it will. */
      exited: Promise<void>;
    }
  | { kind: "error"; error: Error };

/**
 * Run one git command directly, for the cases simple-git can't serve: it has no
 * way to write to the child's stdin, nor to kill a child that takes too long.
 * Everything else matches a git client's command — the same sanitised
 * environment, the same `-c` overrides, the same command log.
 *
 * Never rejects: a git that can't start is an `error`, a non-zero exit is an
 * `ok` with its exit code. A child past `timeoutMs`, or whose `signal` aborts,
 * is sent a kill (best-effort, see `killTree`) and reported as `timeout` /
 * `aborted` at once; nothing a settled run prints is used.
 *
 * See ADR-0028 before adding a caller that writes, runs hooks or goes to the network.
 */
export function spawnGit(options: GitSpawnOptions): Promise<GitSpawnResult> {
  const { signal } = options;
  if (signal?.aborted === true) {
    return Promise.resolve({ kind: "aborted", exited: Promise.resolve() });
  }
  const args = [...GIT_CONFIG_OVERRIDES.flatMap((c) => ["-c", c]), ...options.args];
  options.onCommand?.(options.gitPath, args);
  // `detached` on Windows is a console of its own, not a process group.
  const group = options.ownProcessGroup === true && process.platform !== "win32";
  return new Promise((resolve) => {
    const child = cp.spawn(options.gitPath, args, {
      cwd: options.cwd,
      env: gitChildEnv(options.gitEnv),
      windowsHide: true,
      detached: group
    });
    // `close` comes once every process holding the child's stdio has let go
    // of it — git's own children inherit its stderr — or `error` once it never
    // started.
    const exited = new Promise<void>((done) => {
      child.once("close", () => done());
      child.once("error", () => done());
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killTree(child, group);
            settle({ kind: "timeout" });
          }, options.timeoutMs);
    const onAbort = () => {
      killTree(child, group);
      settle({ kind: "aborted", exited });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    function settle(result: GitSpawnResult) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    // A multi-byte character split across two chunks is put back together
    // before it is handed on.
    const decoder = new TextDecoder();
    child.stderr.on("data", (c: Buffer) => {
      stderr.push(c);
      if (options.onStderr !== undefined && !settled) {
        options.onStderr(decoder.decode(c, { stream: true }));
      }
    });
    // A child that exits before reading all of stdin (or never started) makes
    // the pipe error with EPIPE; the outcome is reported by `close` / `error`.
    child.stdin.on("error", () => {});
    child.on("error", (error) => settle({ kind: "error", error }));
    child.on("close", (exitCode) =>
      settle({
        kind: "ok",
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString()
      })
    );
    child.stdin.end(options.stdin);
  });
}

/** A git command whose output is read as it comes (`streamGit`). */
export type GitStream = {
  /** Each piece of stdout, in order, while `resume` lets them flow. */
  onData(listener: (chunk: Buffer) => void): void;
  /** Stop reading stdout: git fills the pipe and then waits, writing nothing
   *  more, until `resume`. Paused from the start. */
  pause(): void;
  resume(): void;
  /** Stop it: its stdout closed, unread, and the child killed (best-effort,
   *  see `killTree`). `killTree` is a no-op on an exited child; stdout is
   *  closed either way. `ended` settles after, whatever was left in the pipe. */
  kill(): void;
  /** Settles once it has ended — stdout read to its end, or killed: the exit
   *  code (null when killed by a signal) and all of stderr, or why it never
   *  started. */
  ended: Promise<{ exitCode: number | null; stderr: string } | { error: Error }>;
};

/**
 * Run one git command whose stdout is read piece by piece, with backpressure:
 * for output a caller wants only part of now and maybe the rest later, such as
 * a page of a long `git log` (#408), without git writing — or the caller
 * holding — the whole of it at once. The same environment, `-c` overrides and
 * command log as `spawnGit`. A read only: stdin is closed at once.
 */
export function streamGit(
  options: Pick<GitSpawnOptions, "gitPath" | "cwd" | "args" | "onCommand" | "gitEnv">
): GitStream {
  const args = [...GIT_CONFIG_OVERRIDES.flatMap((c) => ["-c", c]), ...options.args];
  options.onCommand?.(options.gitPath, args);
  const child = cp.spawn(options.gitPath, args, {
    cwd: options.cwd,
    env: gitChildEnv(options.gitEnv),
    windowsHide: true
  });
  child.stdout.pause();
  const stderr: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => stderr.push(c));
  child.stdin.on("error", () => {});
  child.stdin.end();
  const ended = new Promise<{ exitCode: number | null; stderr: string } | { error: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("close", (exitCode) =>
        resolve({ exitCode, stderr: Buffer.concat(stderr).toString() })
      );
    }
  );
  return {
    onData: (listener) => child.stdout.on("data", listener),
    pause: () => child.stdout.pause(),
    resume: () => child.stdout.resume(),
    kill: () => {
      // Stop reading too, for good. A child's `close` waits for its stdout to
      // close. Node resumes it when the child exits, but a reader that pauses
      // on every piece — the file history's, once it has a page — pauses it
      // again, and what git wrote before it died is never read to its end:
      // `ended` never settles and the pipe stays open (#484, ADR-0028).
      // Dropping the read end also ends a git still writing, should the kill
      // miss it.
      child.stdout.destroy();
      killTree(child);
    },
    ended
  };
}
