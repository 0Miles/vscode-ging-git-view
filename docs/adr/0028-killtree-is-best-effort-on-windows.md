---
status: accepted
---

# Windows 上的 `killTree` 是盡力而為:取消立刻 settle,殺掉整棵 tree 不保證

`spawnGit` 在 timeout 或 abort 時呼叫 `killTree`,Windows 上的實作是 `taskkill /pid <git> /T /F`。契約是:**立刻 settle,送出 kill,永遠不等 `taskkill` 結束;整棵 tree 會不會結束不保證。** 兩條硬規則不變:已經結束的 child 不再 `taskkill`(它的 PID 可能已經給了無關的行程),已 settle 的 run 的輸出一律不用。

不保證,是因為有三個已知缺口,git 底下的行程可以從中逃掉,繼續跑它的下一個指令([#361](https://github.com/0Miles/vscode-ging-git-view/issues/361),診斷在 [#343](https://github.com/0Miles/vscode-ging-git-view/issues/343)):

1. **晚出生的子行程**:`taskkill /T` 先對 tree 拍 snapshot 再逐一終止,snapshot 之後、parent 被終止之前才出生的子行程(例如 `cmd\git.exe` wrapper 底下真正的 git)不在名單上。
2. **從葉子往上殺**:MSYS `sh` 把被終止的子行程當成 exit 0,所以 `a && b` 會接著跑 `b`,搶在輪到 shell 之前。
3. **MSYS exec 出來的程式**:fork stub 結束後它就沒有 Windows parent,`/T` 碰不到它。

這篇決定**現在不修,只把它寫清楚**。POSIX 上「git 收到信號會收拾自己的子行程」沒有量測過,註解照實標成未量測。

## 為什麼未來的讀者會困惑

- **「註解說殺掉整棵 tree,為什麼還會有孤兒?」** 因為它從來就殺不乾淨,只是以前的註解沒說。#343 的掃描裡,每一個倖存者都來自 `!` alias,沒有一個來自 GING 實際會跑的指令;數據見 #343。
- **「逃掉的行程跑完了,為什麼可以接受?」** 因為今天會走到 kill 的呼叫端都是唯讀、不走網路的,所以沒有 credential helper;唯一的例外是未驗證的 `core.fsmonitor` hook。最壞的情況是一個逃掉的 git 把一次有上限(`BLAME_MAX_BYTES`)的 blame 跑完。先例是 ADR-0024:它已經接受一次被作廢的載入最多白費四個 git 子行程。逐個呼叫端的分析見 #361 的 Triage 定案。
- **「為什麼沒有測 tree 長到一半就被 kill 的情況?」** `gitSpawn.test.ts` 的兩個 tree-kill 測試都刻意等 alias 的 `started` 出現才 kill,避開成因 1。反過來寫一個「預期會有倖存者」的測試,本身就是 race,兩個方向都會 flaky。測試應該跟未來真正的修正一起進來。

## 考慮過但否決的方案

- **Job Object(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`),讓整棵 tree 一起結束。** 暫不採用:它需要 native addon 或 FFI,會失去單一通用的 VSIX(ADR-0026;這是成本,不是規則);它擋不擋得住成因 3 **沒有驗證過**。
  - libuv 自己替 Node 行程建的 job 不能替代:那是整個行程共用的 job,沒辦法只結束一次 run 的 tree。
  - 桌面版([#291](https://github.com/0Miles/vscode-ging-git-view/issues/291))用 Electron,限制一樣,不算另一個觸發條件。
- **`taskkill` 結束後再掃一次孤兒。** 否決。成因 2 在 `taskkill` 結束之前就已經造成影響,事後再掃一定太晚;成因 3 的行程沒有活著的 Windows parent,用 parent PID 也找不到它。而且拿過時的 PID 去比對,可能誤殺無關的行程,違反上面那條防 PID 重用的硬規則。
- **等 `taskkill` 結束再 settle。** 違反 #343 triage 留下的契約(abort 要立刻返回),而且補不了任何一個缺口:三種逃掉的行程,在 `taskkill` 結束時本來就不在它手上。

## 後果

- **`killTree`、`spawnGit`、`GitRunOptions`、`createLatestLoads` 的註解就是契約;不要把「殺掉」寫回去。**
- **重新評估的觸發條件**,碰到任何一條就重開這個決定(擱置的問題列在 #361):
  1. **有實際傷害**:真實回報、可以用 GING 實際會跑的指令(不是 alias)重現,而且逃掉的行程擋住了使用者的操作(改名、刪除、checkout、`index.lock`),或在該次查詢的期限(`BLAME_TIMEOUT_MS` / `FIND_TIMEOUT_MS`)之後還在跑。
  2. **範圍擴大**:任何 git 的 kill 路徑多了會寫入、會跑 hook 或會走網路的呼叫端,包括替 simple-git 接上 `AbortSignal`。

## 補記(2026-11-17,#395)

**重新評估條件 2 被觸發了:clone 是第一個會寫入、會走網路的 kill 路徑呼叫端(取消 clone = `AbortSignal` → `killTree`)。評估後維持這篇的決定(盡力而為、立刻 settle),另外補上 POSIX 的一個缺口。**

- **逃掉的行程能碰到的只有目的地。** clone 只寫進它自己的目的地資料夾,取消或失敗之後 core 的 [clone.ts](../../packages/core/src/backend/actions/clone.ts) 會把 clone 建的東西刪掉(原本不存在就整個刪,原本是空資料夾就清空)。刪除用 `fs.rm` 的重試(10 次、遞增間隔),吸收「剛被 kill 的 git 還握著檔案、或又寫了一個」的那一段;Windows 上唯讀的物件檔先改成可寫再試一次。刪不掉時不假裝成功:命令服務用 `Prompts.showWarning` 說哪個資料夾還留著。
- **POSIX 的缺口實測存在:`child.kill()` 只送給 git 本身,而 git 不會收掉它為 HTTP remote 開的 `git-remote-http`**(git 的 `transport-helper.c` 沒有替 helper 設 `clean_on_exit`),helper 會帶著連線一直卡在 server 上。上面「Elsewhere … unmeasured」那句因此改寫。修法是 `spawnGit` 多一個選填的 `ownProcessGroup`:Windows 以外用 `detached` 讓 git 自成一個 process group,kill 時 `process.kill(-pid, "SIGTERM")` 整組送出。只有 clone 用它;其他呼叫端都是唯讀、不走網路,維持原狀。#450 讓 fetch / push 接上 `AbortSignal` 時,也要用它。
- **量測。** core 的 vitest(`packages/core/tests/actions/clone/clone.test.ts`「kills git, its remote helper with it, and removes the folder it made」)與 Electron E2E(`apps/desktop/e2e/clone.spec.ts`「Cancel stops git…」)都對一個永遠不回應的本機 HTTP server clone,取消後斷言目的地不見、server 上的連線歸零。Windows 上 `taskkill /T` 收得掉整棵(git wrapper、git、`git-remote-https`);ubuntu 上靠 process group。
- **三個缺口仍在。** clone 等 askpass 時,樹裡有 MSYS 的 `sh`(`askpass.sh`)與它啟動的 helper,缺口 2、3 照樣適用;但 askpass 的提示是 modal,蓋住了 clone 面板的取消鈕,從 UI 取消不到正在問帳密的 clone,只有 app 結束會走到那條路(那時 Welcome page 的 `Prompts` 先把提示答成取消,git 自己結束)。
- **不重開 Job Object 方案。** 最壞的情況是一個逃掉的行程在目的地被刪的同時又寫了一點東西,而刪除的重試會在它結束後收拾;沒有寫到目的地以外的路。
