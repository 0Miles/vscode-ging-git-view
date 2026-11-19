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
 *  `spawnGit` rather than a git client, so that `signal` stops it with
 *  `killTree` and its process group (ADR-0028) — the remote helper holding the
 *  connection included, which simple-git's own kill leaves running (#450). */
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
      if (result.exitCode === 0) return;
      throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.exitCode}`);
    case "aborted":
      net.onAborted?.(result.exited);
      throw new GitAbortedError(`git ${args[0]}`);
    case "timeout":
      throw new Error(`git ${args[0]} timed out`);
    case "error":
      throw result.error;
  }
}
