import type { SimpleGit } from "simple-git";

import { type GitCommandHandler, type GitSpawnResult, spawnGit } from "./gitSpawn";
import { GitAbortedError } from "./utils/gitError";

/** Where and how a git run happens. See ADR-0028 before adding a caller that
 *  writes, runs hooks or goes to the network. */
export type GitRunOptions = {
  gitPath: string;
  repoPath: string;
  /** Epoch ms by which the run must be done; one budget can be shared by all
   *  the runs of a lookup. Each caller says what it defaults to. */
  deadline?: number;
  onCommand?: GitCommandHandler;
  gitEnv?: NodeJS.ProcessEnv;
  /** Ends every run of the lookup at once, its processes sent a kill
   *  (best-effort, see `killTree` in `gitSpawn.ts`). */
  signal?: AbortSignal;
};

/** Run git in `git.repoPath` within `deadline`; null when it has already
 *  passed, without spawning anything. */
export function runWithin(
  git: GitRunOptions,
  deadline: number,
  args: string[],
  stdin?: string
): Promise<GitSpawnResult> | null {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  return spawnGit({
    gitPath: git.gitPath,
    cwd: git.repoPath,
    args,
    stdin,
    timeoutMs: remaining,
    onCommand: git.onCommand,
    gitEnv: git.gitEnv,
    signal: git.signal
  });
}

/** How a git run that goes to the network is spawned: on its own, through
 *  `spawnGit` rather than a git client, so that `signal` sends it a kill with
 *  `killTree` and its process group (ADR-0028) — aimed at the remote helper
 *  holding the connection too, which simple-git's own kill leaves running
 *  (#450). Best-effort, as every `killTree` is. */
export type NetworkGit = {
  gitPath: () => string;
  gitEnv?: NodeJS.ProcessEnv;
  onCommand?: GitCommandHandler;
  /** Stops every run at once; a run that would start after it has aborted is
   *  never spawned. */
  signal?: AbortSignal;
  /** Handed, for a run `signal` stopped, what settles once that git and all
   *  it started are gone (`spawnGit`'s `exited`): for a host that must not
   *  exit before them — on Windows the kill is a `taskkill` of its own, which
   *  an app exiting at once can cut short (#450). */
  onAborted?: (exited: Promise<void>) => void;
};

/** Run git `args` in `repo`, for the network. Resolves on exit 0; rejects with
 *  what git printed on any other exit, with `GitAbortedError` once `signal`
 *  has aborted it (or had before it started), and with the spawn's error when
 *  git could not start. */
export async function runNetworkGit(net: NetworkGit, repo: string, args: string[]): Promise<void> {
  await runNetworkGitOutput(net, repo, args);
}

/** The git subcommand `args` run, past any `-c <config>` before it. */
function subcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i++;
    else if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

/** The subcommands of a git client's that go to the network, and so run
 *  through `NetworkGit` in `stoppableNetworkCommands`. */
const NETWORK_SUBCOMMANDS = new Set(["fetch", "push", "ls-remote"]);

/** `runNetworkGit`, resolving to what git printed on stdout. */
export async function runNetworkGitOutput(
  net: NetworkGit,
  repo: string,
  args: string[]
): Promise<string> {
  const name = `git ${subcommand(args) ?? args[0]}`;
  // What simple-git's own guard refuses of a network command, refused here
  // too: a remote or ref named like one of these options would otherwise run
  // a command of its choosing.
  const unsafe = args.find((a) => /^--(upload-pack|receive-pack|exec)(=|$)/.test(a));
  if (unsafe !== undefined) throw new Error(`${name}: ${unsafe} is not permitted`);
  const result = await spawnGit({
    gitPath: net.gitPath(),
    cwd: repo,
    args,
    onCommand: net.onCommand,
    gitEnv: net.gitEnv,
    signal: net.signal,
    ownProcessGroup: true
  });
  switch (result.kind) {
    case "ok":
      if (result.exitCode === 0) return result.stdout.toString();
      throw new Error(
        result.stderr.trim() ||
          result.stdout.toString().trim() ||
          `${name} exited with ${result.exitCode}`
      );
    case "aborted":
      net.onAborted?.(result.exited);
      throw new GitAbortedError(name);
    case "timeout":
      throw new Error(`${name} timed out`);
    case "error":
      throw result.error;
  }
}

/**
 * `git`, its `raw` calls that go to the network (fetch, push, ls-remote) run
 * through `net` in `repo` instead (#450): the graph's own Fetch button and its
 * pushes, which reach git as `raw` calls on the client the dispatch holds.
 * Every other call is the client's own.
 */
export function stoppableNetworkCommands(
  git: SimpleGit,
  repo: () => string,
  net: NetworkGit
): SimpleGit {
  return new Proxy(git, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "raw") return typeof value === "function" ? value.bind(target) : value;
      return (...rawArgs: unknown[]) => {
        const args = (Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs).filter(
          (a): a is string => typeof a === "string"
        );
        const name = subcommand(args);
        return name !== undefined && NETWORK_SUBCOMMANDS.has(name)
          ? runNetworkGitOutput(net, repo(), args)
          : target.raw(args);
      };
    }
  });
}
