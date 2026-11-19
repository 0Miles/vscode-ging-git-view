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

- **取消後先等 git 真的走了,才收拾。** `spawnGit` 照舊在 kill 之後立刻 settle,但 `aborted` 的結果多帶一個 `exited`:child 結束、而且所有共用它輸出的行程(git 的子行程繼承它的 stderr,`index-pack` 也是)都關掉之後才 settle。clone 先等它,最多 5 秒(`CANCELLED_GIT_GRACE_MS`),才開始刪;否則 POSIX 上被 kill 的 git 與 `index-pack` 可能還在寫,刪除列出的清單之後才出現的檔案會漏掉。原本是空資料夾的目的地,清空之後再看一次,有剩就照實回答「還留著」。這不違反「立刻 settle」:等的是呼叫端,`spawnGit` 不等。
- **逃掉的行程能碰到的只有目的地。** clone 只寫進它自己的目的地資料夾,取消或失敗之後 core 的 [clone.ts](../../packages/core/src/backend/actions/clone.ts) 會把 clone 建的東西刪掉(原本不存在就整個刪,原本是空資料夾就清空)。刪除用 `fs.rm` 的重試(10 次、遞增間隔),吸收「剛被 kill 的 git 還握著檔案、或又寫了一個」的那一段;Windows 上唯讀的物件檔先改成可寫再試一次。刪不掉時不假裝成功:命令服務用 `Prompts.showWarning` 說哪個資料夾還留著。
- **POSIX 的缺口實測存在:`child.kill()` 只送給 git 本身,而 git 不會收掉它為 HTTP remote 開的 `git-remote-http`**(git 的 `transport-helper.c` 沒有替 helper 設 `clean_on_exit`),helper 會帶著連線一直卡在 server 上。上面「Elsewhere … unmeasured」那句因此改寫。修法是 `spawnGit` 多一個選填的 `ownProcessGroup`:Windows 以外用 `detached` 讓 git 自成一個 process group,kill 時 `process.kill(-pid, "SIGTERM")` 整組送出。只有 clone 用它;其他呼叫端都是唯讀、不走網路,維持原狀。POSIX 上 Node 的 `detached` 是 `setsid`:除了自成 process group,也是自成 session、脫離控制終端機;git 與 helper 從不在終端機上問東西(帳密走 askpass),所以沒有損失。另外,app 本身當掉時 git 會繼續跑完 —— 沒有人在 parent 死掉時送它信號(沒有 pdeathsig),這一點有沒有 `detached` 都一樣。#450 讓 fetch / push 接上 `AbortSignal` 時,也要用它。
- **量測。** core 的 vitest(`packages/core/tests/actions/clone/clone.test.ts`「kills git, its remote helper with it, and removes the folder it made」)與 Electron E2E(`apps/desktop/e2e/clone.spec.ts`「Cancel stops git…」)都對一個永遠不回應的本機 HTTP server clone,取消後斷言目的地不見、server 上的連線歸零。Windows 上 `taskkill /T` 收得掉整棵(git wrapper、git、`git-remote-https`);ubuntu 上靠 process group。
- **三個缺口仍在。** clone 等 askpass 時,樹裡有 MSYS 的 `sh`(`askpass.sh`)與它啟動的 helper,缺口 2、3 照樣適用;但 askpass 的提示是 modal,蓋住了 clone 面板的取消鈕,從 UI 取消不到正在問帳密的 clone,只有 app 結束會走到那條路(那時 Welcome page 的 `Prompts` 先把提示答成取消,git 自己結束)。
- **不重開 Job Object 方案。** 最壞的情況是一個逃掉的行程在目的地被刪的同時又寫了一點東西,而刪除的重試會在它結束後收拾;沒有寫到目的地以外的路。

## 補記(2026-11-19,#450)

**重新評估條件 2 再次被觸發:fetch 與 push 是第二個會寫入、會走網路的 kill 路徑呼叫端。評估後維持這篇的決定(盡力而為、立刻 settle)。** 上面 #395 補記裡「只有 clone 用它」從此不成立。

- **哪些呼叫端。** core 的 `runNetworkGit`(`packages/core/src/backend/gitRun.ts`)經 `spawnGit` 跑 fetch,帶 `signal` 與 `ownProcessGroup`;`stoppableNetworkCommands` 把一個 git client 的 `raw` fetch、push、`ls-remote` 改走它,所以 graph 自己的 Fetch 鈕與 bridge 的 push(分支與 tag)也在內。signal 在桌面版 instance 被處置(關 Tab、結束 app)時、在 VS Code extension `deactivate` 時 abort。被中止的 git 一律只寫 log、不跳錯誤框。
- **宿主要等它走。** Windows 上的 kill 是另外 spawn 的 `taskkill`,宿主若在它做完之前就結束(app 結束、extension host 結束),整棵樹會留著、連線還在。所以 `aborted` 的 `exited` 交給宿主(`NetworkGit.onAborted`):桌面版 `will-quit` 最多等 5 秒(`QUIT_WAITS_FOR_GIT_MS`),VS Code 的 `deactivate` 最多等 3 秒(`DEACTIVATE_WAITS_FOR_GIT_MS`,在 VS Code 給 `deactivate` 的 5 秒之內)。關 Tab 不需要等:app 還活著,`taskkill` 會做完。
- **新的傷害:ref 的鎖檔。** 用 `/F` 殺掉正在更新 ref 的 fetch,可能留下 `refs/**.lock`,下一次 fetch 會失敗("cannot lock ref … File exists")。review 用 30000 個 ref 重現過，實際上的窗口只有幾毫秒寬。這篇不處理：使用者要刪掉那個鎖檔，跟 git 自己被中斷時一樣;要是有真實回報，就照條件 1 重開。
- **pull 不殺。** `pull` 抓完之後會在工作目錄裡 merge 或 rebase;在那一段用 `/F` 殺掉,rebase 的 pull 會留下 `.git/rebase-merge` 與 detached HEAD,merge 的 pull 會留下 staged 一半、沒有 `MERGE_HEAD` 的合併(review 在 git 2.40.1 上實測)。所以 `pull` 不在 `stoppableNetworkCommands` 改走的子命令裡，照舊在 git client 上跑完。代價：卡在永遠不回應的 server 上的 pull,關 Tab 或結束 app 之後仍會留著,跟 #450 之前一樣。不改成「fetch 再 merge / rebase」:要重現 `pull.rebase`、`pull.ff`、`branch.<name>.rebase` 與 upstream 的解析，風險比留著一個卡住的 pull 大。測試:`packages/core/tests/extension/fetchAbort.test.ts` 用 hook 把 pull 停在合併中、abort signal、再放行，斷言 pull 完成、沒有進行中的 merge 或 rebase。
- **仍然是盡力而為。** 上面三個缺口照樣適用;程式碼註解寫的是「送出 kill」,不是「保證收掉」。

## 補記(2026-11-18,#484)

**`streamGit`(#408 的檔案歷史用)的 `kill` 先關掉 stdout 的讀取端,再 `killTree`。** 它不是 `killTree` 的缺口(git 確實被殺了),是串流讀者自己的:Node 的 child `close` 要等 stdout 關閉。child 結束時 Node 會把暫停的 stdout 放開一次,但檔案歷史的讀者每拿到一段、手上有一頁就再暫停,git 死前已經寫進 pipe 的其餘部分就永遠讀不到結尾 —— `close` 不來,`ended` 不 settle,pipe 的 handle 也留著。剩下的輸出若剛好一次讀完(連同結尾)就沒事,所以它時紅時綠,Windows 的 pipe 一次讀到的量不同,更常紅:Windows CI 上「stops git when closed」逾時 30 秒就是這個(#484)。在本機以 4 MiB 的 blob 讓 git 卡在滿的 pipe 上再殺,舊的 `kill` 每次都卡住(`packages/core/tests/gitSpawn.test.ts` 的 `streamGit` 一組)。

- **關掉讀取端本身也讓還在寫的 git 結束**(寫入失敗),所以即使 `taskkill /T` 漏掉了真正的 git(本 ADR 的三個缺口),它也不會一直卡在 pipe 上。
- **不改用 `exit` 判斷結束。** `exit` 在 stdio 還開著時就會來,能讓 `ended` 早一點 settle,但 pipe 的 handle 照樣留著沒人關;關掉讀取端是讓兩者都結束的那一步。
