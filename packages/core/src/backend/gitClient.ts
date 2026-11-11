import type { SimpleGit, SimpleGitOptions } from "simple-git";
import { simpleGit } from "simple-git";

import { GIT_CONFIG_OVERRIDES, type GitCommandHandler, gitChildEnv } from "./gitSpawn";

export type { GitCommandHandler } from "./gitSpawn";

export type GitClient = ReturnType<typeof gitClientFactory>;
export type GitInstance = GitClient["getInstance"];

/** `null` is no repository: simple-git then runs git where the host process
 *  is, for a question that is git's own or the global config's. */
function gitOptions(repoPath: string | null, gitPath: string): Partial<SimpleGitOptions> {
  return {
    ...(repoPath !== null && { baseDir: repoPath }),
    binary: gitPath,
    maxConcurrentProcesses: 6,
    trimmed: false,
    // See GIT_CONFIG_OVERRIDES: shared with the commands spawnGit runs.
    config: [...GIT_CONFIG_OVERRIDES],
    // Allow the GIT_ASKPASS helper we set below, and the GIT_EDITOR /
    // GIT_SEQUENCE_EDITOR we set on the instance (commands we control, not
    // external input). simple-git blocks askpass/editor env by default — and
    // without allowUnsafeEditor it rejects EVERY command once GIT_EDITOR is set.
    unsafe: { allowUnsafeAskPass: true, allowUnsafeEditor: true }
  };
}

export function gitClientFactory(
  repoPath: string | null,
  gitPath: string,
  onCommand?: GitCommandHandler,
  // Extra environment for spawned git processes — e.g. the GIT_ASKPASS handles
  // for credential prompting. Scoped to this client's git children rather
  // than process.env so it can't leak to other extensions sharing the host.
  gitEnv?: NodeJS.ProcessEnv
) {
  // 明確收下 baseDir 與 binary,而不是讀閉包變數:setter 因此能先建構、確定成功
  // 之後才寫回狀態(見下方)。
  const create = (forRepoPath: string | null, forGitPath: string): SimpleGit => {
    const instance = simpleGit(gitOptions(forRepoPath, forGitPath));
    instance.env(gitChildEnv(gitEnv));
    if (onCommand !== undefined) {
      instance.outputHandler((command, _stdout, _stderr, args) => onCommand(command, args));
    }
    return instance;
  };
  let git: SimpleGit = create(repoPath, gitPath);

  // 兩個 setter 都是交易式的:先讓 create() 跑完,成功了才寫回 repoPath / gitPath
  // / git,失敗則三者一律不動,呼叫端拿到的例外與先前完全相同。
  //
  // 這是必要的,因為 simple-git 的建構會同步驗證 baseDir:對不存在、或存在但不是
  // 目錄的路徑,gitInstanceFactory 直接 throw GitConstructError。先寫欄位再建構的
  // 話,一次失敗的 setRepo 會在閉包裡留下一個壞的 repoPath;之後任何一次 create()
  // ——包括使用者改 ging-git-view.git.path 時觸發、而且沒有 try/catch 的
  // setGitPath ——都會再炸一次。那不是一次失敗,是一個持續產出錯誤結果的損毀狀態。
  return {
    getInstance: (): SimpleGit => git,
    setRepo(newRepoPath: string) {
      const next = create(newRepoPath, gitPath);
      repoPath = newRepoPath;
      git = next;
    },
    setGitPath(newGitPath: string) {
      const next = create(repoPath, newGitPath);
      gitPath = newGitPath;
      git = next;
    }
  };
}
