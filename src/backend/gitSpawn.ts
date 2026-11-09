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
  /** Kill the child and resolve `timeout` once it has run this long. */
  timeoutMs?: number;
  onCommand?: GitCommandHandler;
  gitEnv?: NodeJS.ProcessEnv;
};

/**
 * Kill `child` and everything it started. On Windows `child.kill()` ends only
 * the direct child — and the `git` found on PATH is usually Git for Windows'
 * `cmd\git.exe` wrapper, so the real git (and any shell it runs) would carry on
 * working. `taskkill /T` takes the whole tree. Elsewhere git cleans up the
 * children it started when it is signalled.
 */
function killTree(child: cp.ChildProcess) {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = cp.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => child.kill());
  } else {
    child.kill();
  }
}

export type GitSpawnResult =
  | { kind: "ok"; exitCode: number | null; stdout: Buffer; stderr: string }
  | { kind: "timeout" }
  | { kind: "error"; error: Error };

/**
 * Run one git command directly, for the cases simple-git can't serve: it has no
 * way to write to the child's stdin, nor to kill a child that takes too long.
 * Everything else matches a git client's command — the same sanitised
 * environment, the same `-c` overrides, the same command log.
 *
 * Never rejects: a git that can't start is an `error`, a non-zero exit is an
 * `ok` with its exit code, and a child past `timeoutMs` is killed — with every
 * process under it — and reported as `timeout` without waiting for it to go.
 */
export function spawnGit(options: GitSpawnOptions): Promise<GitSpawnResult> {
  const args = [...GIT_CONFIG_OVERRIDES.flatMap((c) => ["-c", c]), ...options.args];
  options.onCommand?.(options.gitPath, args);
  return new Promise((resolve) => {
    const child = cp.spawn(options.gitPath, args, {
      cwd: options.cwd,
      env: gitChildEnv(options.gitEnv),
      windowsHide: true
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killTree(child);
            settle({ kind: "timeout" });
          }, options.timeoutMs);
    let settled = false;
    function settle(result: GitSpawnResult) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
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
