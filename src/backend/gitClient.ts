import type { SimpleGit, SimpleGitOptions } from "simple-git";
import { simpleGit } from "simple-git";

export type GitClient = ReturnType<typeof gitClientFactory>;
export type GitInstance = GitClient["getInstance"];

function gitOptions(repoPath: string, gitPath: string): Partial<SimpleGitOptions> {
  return {
    baseDir: repoPath,
    binary: gitPath,
    maxConcurrentProcesses: 6,
    trimmed: false,
    // Disable coloured output on every command so user git config such as
    // color.branch = always can't inject ANSI escapes into the values we parse
    // (e.g. branch names in the dropdown). Per-command color.* settings take
    // precedence over color.ui, so each parsed command's key is set explicitly.
    // log.showSignature is likewise forced off: when a user enables it, git log
    // prepends GPG verification lines to each commit, corrupting our parsing.
    config: [
      "color.ui=false",
      "color.branch=false",
      "color.diff=false",
      "color.status=false",
      "color.decorate=false",
      "color.log=false",
      "log.showSignature=false"
    ],
    // Allow the GIT_ASKPASS helper we set below, and the GIT_EDITOR /
    // GIT_SEQUENCE_EDITOR we set on the instance (commands we control, not
    // external input). simple-git blocks askpass/editor env by default — and
    // without allowUnsafeEditor it rejects EVERY command once GIT_EDITOR is set.
    unsafe: { allowUnsafeAskPass: true, allowUnsafeEditor: true }
  };
}

/** Called for every spawned git command (binary + args), for logging. */
export type GitCommandHandler = (command: string, args: string[]) => void;

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

export function gitClientFactory(
  repoPath: string,
  gitPath: string,
  onCommand?: GitCommandHandler,
  // Extra environment for spawned git processes — e.g. the GIT_ASKPASS handles
  // for credential prompting. Scoped to this client's git children rather
  // than process.env so it can't leak to other extensions sharing the host.
  gitEnv?: NodeJS.ProcessEnv
) {
  const create = (): SimpleGit => {
    const instance = simpleGit(gitOptions(repoPath, gitPath));
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
    instance.env(childEnv);
    if (onCommand !== undefined) {
      instance.outputHandler((command, _stdout, _stderr, args) => onCommand(command, args));
    }
    return instance;
  };
  let git: SimpleGit = create();

  return {
    getInstance: (): SimpleGit => git,
    setRepo(newRepoPath: string) {
      repoPath = newRepoPath;
      git = create();
    },
    setGitPath(newGitPath: string) {
      gitPath = newGitPath;
      git = create();
    }
  };
}
