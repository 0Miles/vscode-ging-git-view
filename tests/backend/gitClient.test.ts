import * as path from "node:path";

import { GitConstructError } from "simple-git";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { gitClientFactory } from "@/backend/gitClient";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

describe("gitClientFactory (real git)", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    rmrf(repo);
  });

  it("runs commands with GIT_EDITOR set (needs unsafe.allowUnsafeEditor)", async () => {
    // The factory bakes in GIT_EDITOR=true; without unsafe.allowUnsafeEditor,
    // simple-git rejects EVERY command, which blanked the whole graph.
    const client = gitClientFactory(repo, "git");
    const head = await client.getInstance().raw(["rev-parse", "HEAD"]);
    expect(head.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  // Regression: simple-git spawns each git child with exactly the object handed
  // to .env(), NOT merged with process.env. The factory must rebuild that
  // inheritance, or the child loses HOME/PATH — git can't read ~/.gitconfig or
  // run credential helpers and pushes fail with "Repository not found".
  describe("inherits the parent environment", () => {
    const saved: Record<string, string | undefined> = {};
    const setEnv = (key: string, value: string) => {
      saved[key] = process.env[key];
      process.env[key] = value;
    };
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("forwards an inherited variable to git children", async () => {
      const marker = `ngg-marker-${process.pid}`;
      // A `!`-shell alias that echoes a variable only the parent knows: it can
      // only resolve if the spawned git inherited process.env.
      git(["config", "alias.nggechomarker", '!printf %s "$NGG_TEST_MARKER"'], repo);
      setEnv("NGG_TEST_MARKER", marker);
      const client = gitClientFactory(repo, "git");
      const out = await client.getInstance().raw(["nggechomarker"]);
      expect(out.trim()).toBe(marker);
    });

    it("drops vars simple-git would reject so every command still runs", async () => {
      // PAGER and GIT_CONFIG_COUNT are present in many shells; left in the env
      // they make simple-git throw "unsafe" on every command (we don't enable
      // their allowUnsafe* flags). They must be stripped before spawning.
      setEnv("PAGER", "less");
      setEnv("GIT_CONFIG_COUNT", "1"); // companion KEY/VALUE absent on purpose
      const client = gitClientFactory(repo, "git");
      const head = await client.getInstance().raw(["rev-parse", "HEAD"]);
      expect(head.trim()).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  // simple-git 的建構是同步驗證 baseDir 的:`gitInstanceFactory` 呼叫
  // `folderExists()`(底層是 `@kwsites/file-exists` 的 `statSync`),不通過就
  // 直接 `throw new GitConstructError`。下面兩個 case 釘住那道守門的兩個分支。
  //
  // 未涵蓋的是第三條:`statSync` 的 catch 只吞 `ENOENT`,其餘一律 re-throw,
  // 所以不可達的 UNC 路徑拋的是裸 `Error { code: "UNKNOWN" }` 而不是
  // `GitConstructError`;`EACCES` / `EPERM` / `EBUSY` 同。這裡不釘它,理由有二:
  //   1. 要造出那些條件得改檔案系統 ACL 或得有一個網路目標,而這個 repo 的測試
  //      沒有任何改動環境權限的先例(`helpers.ts` 只有 `makeRepo` / `rmrf`)。
  //   2. re-throw 分支的成員隨平台而變 —— 實測 `ENOTDIR` 在 Windows 上回的其實
  //      是 `ENOENT` —— 在單一平台的 CI 上本來就釘不住。
  // 以上為 code-verified、not reproduced。
  describe("rejects an unusable baseDir at construction", () => {
    it("throws GitConstructError when the directory does not exist", () => {
      // 分支一:`statSync` 自己就 `ENOENT`,被 catch 吞掉後回傳 false。
      const dead = makeRepo();
      rmrf(dead);
      expect(() => gitClientFactory(dead, "git")).toThrow(GitConstructError);
    });

    it("throws GitConstructError when the path is a file, not a directory", () => {
      // 分支二:機制與上一個 case **不同**,不是重複。這裡 `statSync` 是成功的
      // —— 路徑確實存在 —— 是 `folderExists()` 只認 FOLDER、而 `isDirectory()`
      // 為 false,才讓它回傳 false。上一個 case 連 `statSync` 都沒走完。
      const file = path.join(repo, "f"); // `makeRepo()` 建立並 commit 的那個檔案
      expect(() => gitClientFactory(file, "git")).toThrow(GitConstructError);
    });
  });

  it("leaves the client usable after setRepo throws", async () => {
    // Regression:兩個 setter 原本是 mutate-then-throw —— `setRepo` 先把閉包裡的
    // `repoPath` 寫成新路徑,才呼叫 `create()`。`create()` 拋出後 `git` 還是舊
    // instance(看起來沒事),但 `repoPath` 已經被污染成那個壞路徑,於是下一次
    // 任何會 `create()` 的呼叫都會再炸一次 —— 包括使用者改
    // `ging-git-view.git.path` 時觸發、而且沒有 try/catch 的 `setGitPath`。
    const client = gitClientFactory(repo, "git");
    const headBefore = (await client.getInstance().raw(["rev-parse", "HEAD"])).trim();

    const dead = makeRepo();
    rmrf(dead);
    expect(() => client.setRepo(dead)).toThrow(GitConstructError);

    // `setGitPath` 不驗證 binary(simple-git 建構時只看 `baseDir`),所以它唯一
    // 會拋的方式,就是拿到一個被失敗的 `setRepo` 寫壞的 `repoPath`。
    expect(() => client.setGitPath("git")).not.toThrow();
    // 而且 `git` 仍指著原本那個 repo,不是別的東西。
    const headAfter = (await client.getInstance().raw(["rev-parse", "HEAD"])).trim();
    expect(headAfter).toBe(headBefore);
  });
});
