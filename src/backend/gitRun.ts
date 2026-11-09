import { type GitCommandHandler, type GitSpawnResult, spawnGit } from "./gitSpawn";

/** Where and how a git run happens. */
export type GitRunOptions = {
  gitPath: string;
  repoPath: string;
  /** Epoch ms by which the run must be done; one budget can be shared by all
   *  the runs of a lookup. Each caller says what it defaults to. */
  deadline?: number;
  onCommand?: GitCommandHandler;
  gitEnv?: NodeJS.ProcessEnv;
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
    gitEnv: git.gitEnv
  });
}
