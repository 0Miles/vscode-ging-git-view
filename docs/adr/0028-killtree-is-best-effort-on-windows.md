---
status: accepted
---

# Windows 上的 `killTree` 是盡力而為:取消立刻 settle,殺掉整棵 tree 不保證

`spawnGit` 在 timeout 或 abort 時呼叫 `killTree`,Windows 上的實作是 `taskkill /pid <git> /T /F`。契約是:**立刻 settle,永遠不等 `taskkill` 結束;殺掉整棵 tree 是 best-effort。** 兩條硬規則不變:已經結束的 child 不再 `taskkill`(它的 PID 可能已經給了無關的行程),已 settle 的 run 的輸出一律不用。

best-effort 的意思是有三個已知缺口,git 底下的行程可以從中逃掉,繼續跑它的下一個指令([#361](https://github.com/0Miles/vscode-ging-git-view/issues/361),診斷與掃描資料在 [#343](https://github.com/0Miles/vscode-ging-git-view/issues/343)):

1. **晚出生的子行程**:`taskkill /T` 先對 tree 拍 snapshot 再逐一終止,snapshot 之後、parent 被終止之前才出生的子行程(`cmd\git.exe` wrapper 底下真正的 git、git 剛啟動的 `sh`)不在名單上。
2. **從葉子往上殺**:MSYS `sh` 把被終止的子行程當成 exit 0,所以 `a && b` 會接著跑 `b`,搶在輪到 shell 之前。
3. **MSYS exec 出來的程式**:fork stub 結束後它就沒有 Windows parent,`/T` 碰不到它。

這篇決定**現在不修,只把它寫清楚**:`killTree` 的註解列出這三個缺口,`spawnGit`、`createLatestLoads` 與 `GitRunOptions.signal` 的註解改說「送出 kill」而不是「殺掉」。POSIX 上「git 收到信號會收拾自己的子行程」沒有量測過,註解照實標成未量測。

## 為什麼未來的讀者會困惑

- **「註解說殺掉整棵 tree,為什麼還會有孤兒?」** 因為它從來就殺不乾淨,只是以前的註解沒說。#343 的掃描(負載下 1200 次,abort 落在 spawn 後 0–300 ms)留下 76 個倖存者:58 個是成因 1,18 個是成因 2。全部來自 `!` alias,沒有一個是 GING 實際會跑的指令。
- **「逃掉的行程跑完了,為什麼可以接受?」** 因為今天會走到 kill 的指令都是唯讀、不走網路的。`runWithin` 的呼叫端只跑 `ls-files`、`blame`、`config --get`、`show`、`diff`、`rev-parse`,所以沒有 credential helper;hook 只剩 `core.fsmonitor` 這個未驗證的例外。abort 只來自 hover(`blameCommitChange` / `blameLineExcerpt` 的 `show` / `diff`,都帶 `--no-textconv`)。`blameFile` 沒有 signal,只有 timeout,但一次查詢的幾個 run 共用同一個期限:負載下前面的 `ls-files` 幾乎用光 5 s 時,`blame` 的 timeout 可能落進成因 1 的視窗,讓 wrapper 底下的真正 git 把一次有上限(`BLAME_MAX_BYTES`)的 blame 跑完。這很少見,代價有上限,而且是唯讀的。先例是 ADR-0024:它已經接受一次被作廢的載入最多白費四個 git 子行程。
- **「為什麼沒有測 tree 長到一半就被 kill 的情況?」** `gitSpawn.test.ts` 的兩個 tree-kill 測試都刻意等 alias 的 `started` 出現才 kill,避開成因 1。反過來寫一個「預期會有倖存者」的測試,本身就是 race,兩個方向都會 flaky;而且 CI 只跑 ubuntu,在 CI 上根本測不到。測試應該跟未來真正的修正一起進來。

## 考慮過但否決的方案

- **Job Object(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`),讓整棵 tree 一起結束。** 暫不採用,原因有三。第一,它需要 native addon 或 FFI,會失去現在單一通用的 VSIX(`vsce package --no-dependencies`,見 ADR-0026),改成依平台打包,連帶要改 Trusted Publishing 的流程。這是讓這條路變貴的**成本**,不是「不准有 native 依賴」的規則。第二,CI 只跑 ubuntu,Windows 只能手動驗證。第三,它擋不擋得住成因 3 **沒有驗證過**,所以就算付了前面的成本,也不保證三個缺口都補上。libuv 自己替 Node 行程建的 job 不能拿來替代:那是整個行程共用的一個 job,沒辦法只結束某一次 run 的 tree。桌面版([#291](https://github.com/0Miles/vscode-ging-git-view/issues/291))用 Electron,限制完全一樣,所以不算另一個觸發條件。
- **`taskkill` 結束後再掃一次孤兒。** 否決。成因 2 在 `taskkill` 結束之前就已經造成影響,事後再掃一定太晚;成因 3 的行程沒有活著的 Windows parent,用 parent PID 也找不到它。而且拿過時的 PID 去比對,可能誤殺無關的行程,違反上面那條防 PID 重用的硬規則。
- **等 `taskkill` 結束再 settle。** 違反 #343 triage 留下的契約(abort 要立刻返回),而且補不了任何一個缺口:三種逃掉的行程,在 `taskkill` 結束時本來就不在它手上。

## 後果

- **註解就是契約。** `killTree` 的註解列出三個缺口並引用這篇;`spawnGit`、`createLatestLoads` 與 `GitRunOptions.signal` 的註解保證「立刻 settle、送出 kill」,不保證行程結束。之後改這幾個地方的人,不要把「殺掉」寫回去。
- **`spawnGit` 的註解帶著範圍觸發條件**,所以新增 kill 路徑的人在呼叫端就會看到它,不必先知道有這篇。
- **重新評估的觸發條件**,碰到任何一條就重開這個決定:
  1. **有實際傷害**:真實回報、可以用 GING 實際會跑的指令(不是 alias)重現,而且逃掉的行程擋住了使用者的操作(改名、刪除、checkout、`index.lock`),或在該次查詢的期限(5 s,`BLAME_TIMEOUT_MS` / `FIND_TIMEOUT_MS`)之後還在跑。
  2. **範圍擴大**:任何 git 的 kill 路徑多了會寫入、會跑 hook 或會走網路的呼叫端,包括替 simple-git 接上 `AbortSignal`。
- **擱置、不影響這個決定的問題**:`ls-files` / `blame` 會不會呼叫 fsmonitor hook、成因 1 在一般指令上命中的頻率、libuv 全域 job 的 flag、MSYS2 的子行程會不會脫離巢狀 job、PowerShell/CIM 的成本、simple-git abort 實際殺掉了什麼。重新評估時從這裡開始查。
