---
status: accepted
---

# 桌面版的側檢視和圖形在同一頁:分支動作直接呼叫圖形,head guard 在 webview

_與 ADR-0009、ADR-0010 看起來衝突:那兩篇說側檢視的分支動作由宿主委派給圖形,head guard 在宿主。這篇不推翻它們 —— 它們的前提(側檢視和圖形在不同行程)在桌面版不成立,所以桌面版走另一條路。VS Code 的行為不變。_

桌面版的 Branches / Remotes 側檢視([#399](https://github.com/0Miles/vscode-ging-git-view/issues/399))畫在每個 Tab 自己的頁面裡,在 ADR-0031 劃好的左側直欄,和圖形是同一份文件、同一個 renderer。所以:

- **分支動作直接呼叫圖形的動作函式。** 側檢視的右鍵選單項目執行時,呼叫 `startGitGraphView()` 回傳的 `GraphInPage`(`runRefAction`、`runRefBatchAction`、`openCleanup`),跑的是圖內選單那一套流程,對話框也是同一個。宿主不經手,沒有 `runRefAction` 訊息、沒有 seq、沒有 `pendingRefAction`,`MessageHandlerDeps.onDelegatedRan` 在桌面版是 no-op,`branchActionDelegate` 桌面不使用(ADR-0027 #388 補記的表)。
- **動作清單與 head guard 都由 webview 依 catalogue 判斷。** [branchMenu.ts](../../packages/webview/src/desktop/sideViews/branchMenu.ts) 從 `REF_ACTION_CATALOGUE` 推導每一列的選單:`refKinds`、`headGuard`、`needsRemotes`、`cmvKey`,多選時只留 `batch: true`。checked-out 那條分支不會出現 head-guarded 的項目;執行前同一個判斷(`singleActionApplies`)再過一次,擋下時保持靜默 —— 選單本來就沒提供它。
- **兩個宿主問的是同一個判斷，只有執行的方式不同。**head guard 是 `refActionCatalogue.ts` 的 `headGuardBlocks`、ref 種類是 `refKindsAdmit`,批次動作「該怎麼辦」是 `branchActionTargets.ts` 的 `planBatch`(交給圖形、在宿主執行、什麼都不做、或說明全被扣除),都在 `@ging/shared`。VS Code 的 `branchActionDelegate` 和桌面版的側檢視各自照著結果去做 —— 一個送 `runRefBatchAction`,一個呼叫 `GraphInPage` —— 規則不會一邊改了另一邊沒跟上。
- **Remotes 側檢視的動作是 core 的命令服務加 `Prompts`。** add / edit URL / rename / remove 是 `remoteCommands`,fetch 是 `fetchService.fetchOneCommand`,管理 pull request provider 是 `pullRequestProviderCommands`,問題問在該 Tab 頁面上的 host prompt overlay。頁面只送一個請求給 main process(`SideViewRequest`),由該實例執行。
- **側檢視顯示什麼由 main process 讀,經 core 決定。** [sideViews.ts](../../apps/desktop/src/sideViews.ts) 讀 `branchFacts` 與 `remoteCommands.list`,樹由 core 的 `sideViewBranchRoots` 建出(VS Code 的 `branchesView.ts` 也改呼叫它),再以 `sideViewState` 送進頁面。

## 為什麼未來的讀者會困惑

- **ADR-0009 說單一分支動作「一律委派給圖形」,這裡卻是直接呼叫。** 委派是手段,不是規則本身。ADR-0009 的目的,是不要把圖內選單已經有的對話框再寫一份;委派是在另一個行程裡達成這件事唯一的辦法,代價是 `openGraphView()` 把面板叫到前景、webview 隱藏時會掉訊息,所以才有 `pendingRefAction` 加 `seq` 的雙路投遞。桌面版的側檢視和圖形在同一頁,直接呼叫就沿用了同一個對話框,而那些代價一個都不存在:沒有面板要叫出來,頁面不會隱藏而另一半還活著,也沒有 reload 要補送。照抄委派只會留下一套沒有對象的補償機制。
- **ADR-0010 說 head guard 在宿主,不在 webview,這裡反過來。** ADR-0010 把它放在宿主的理由是:guard 若在 webview,宿主會先把圖形面板叫到前景、然後 webview 靜默丟棄,使用者看到面板無故彈出。桌面版沒有「叫出面板」這一步,這個理由不成立;而且宿主手上沒有那一列 —— 列在頁面上。所以 guard 放在握著列的那一邊,問的是同一個 `headGuardBlocks`,擋下時一樣靜默:搬動的是「在哪裡問」,不是規則。
- **選單不是寫在 `package.json` 的 when-clause,而是從 catalogue 推導。** VS Code 的選單是靜態 manifest,只能手寫再由 `branchMenuConsistency.test.ts` 鎖住;桌面版的選單由頁面畫,能直接讀 catalogue。唯一不能從 catalogue 推出來的是 `delete` 在 remote 分支單選時改叫 `deleteRemote`(catalogue 在 `delete` 那一筆的註解),寫在 `branchMenu.ts` 的呈現表裡,而那張表是 `Record<CatalogueRefAction, …>`,catalogue 多一筆就編譯不過。
- **ADR-0029 的例外在這裡沒有用到。** 它的適用條件是「圖內對話框要靠已載入的列才能運作」,沒有任何 branch 動作符合:委派過去的分支動作只拿 ref 名稱,branch 清單每次載入都整份讀進來。所以分支側檢視的動作全部走圖形;Remotes 走 core,是因為圖形根本沒有 remote 的對話框,不是因為 ADR-0029。
- **`copyName` 在 VS Code 是 `runsIn: "host"`,在桌面版是頁面送出的 `copyToClipboard`。** 它不詢問任何事(ADR-0009),在桌面版也不碰圖形的流程;走的是圖形本來就有的複製請求,所以失敗時的說法與圖形一致。
- **側檢視的選取恆等於 branch filter,沒有 direct write,也沒有一次性的抑制。** 那兩樣存在,是因為擴充功能設定不了 TreeView 的選取(ADR-0018 的補記、GLOSSARY 的 **Direct write**)。頁面畫得出任何集合,所以反白就是宿主最近一次說的 filter;點選只是請宿主寫一個新的 filter,寫入後由 `onDidChangeFilter` 再送回來。連續 Ctrl/Cmd 點選一樣等 200ms 才寫,只重載一次圖形。每次寫入帶一個序號(`sideViewSetFilter.seq`),宿主送的 state 說它讀的時候已經收下第幾號(`filterSeq`);比頁面最後一次請求舊的 state 不改反白,否則一個在點選之前讀好的 state 會讓反白閃回舊的 filter。

## 考慮過但否決的方案

- **沿用 `createBranchActionDelegate`,`openGraphView` 給一個空函式。** 程式碼最少,但留下的是一條沒有理由的路:seq、兩條投遞路線、等載入的佇列都在補償一個不存在的行程邊界,而 head guard 會留在一個手上沒有列的宿主。
- **選單與批次的 target 解析放在 main process,頁面只送「第幾列被右鍵」。** 每次右鍵都要一來一回才畫得出選單;而且執行還是得回到頁面裡的圖形,等於把委派換個方向再做一次。`branchTree`、`branchActionTargets` 因此從 core 搬到 `@ging/shared`(純 TS),頁面才讀得到(ADR-0018 的補記)。
- **樹在頁面裡從圖形的 `loadBranches` 回覆自己建。** 回覆裡只有 merged 那一半的 hidable,沒有 inactive 與 cleanup candidate;補齊等於讓兩個宿主各算一次分類,正是 ADR-0013 要消滅的東西。

## 後果

- `GraphInPage` 是圖形對同一頁其他部分開的唯一出口,只有桌面入口用;VS Code 入口忽略 `startGitGraphView()` 的回傳值,行為不變。它的方法都以 repo 為參數,圖形顯示的不是那個 repo(例如還在開機)時什麼都不做。
- 新增 catalogue 動作時,桌面版要在 `branchMenu.ts` 的呈現表加一格(編譯器逼你補);ADR-0010「後果」第一條列的三個檔案之外多這一個。
- 側檢視的協定(`SideViewStateMessage` / `SideViewRequest`)在 `desktop/sideViews/protocol.ts`,`SIDE_VIEW_COMMANDS_STAY_APART` 檢查它們不和 `ResponseMessage` / `RequestMessage` 撞名(ADR-0031)。
- 驗證:`packages/webview/tests/desktopSideViewMenu.test.ts`(catalogue 推導)、`desktopSideViews.test.ts`(直接呼叫圖形、head guard 靜默)、`apps/desktop/tests/sideViews.test.ts`(main process 那一半)、`apps/desktop/e2e/sideViews.spec.ts`(篩選、圖形的 Show All、checkout、Remotes 的 rename)。

## 補記(2026-11-18,#400):Stash 側檢視不呼叫圖形

**桌面版的 Stash 側檢視是同一欄的第三段,和圖形在同一頁,但它的動作不呼叫圖形,而是像 VS Code 一樣在宿主執行。** 這不和本文矛盾:本文說分支動作直接呼叫圖形,是因為委派的前提(另一個行程)不存在;stash 走宿主,理由是 ADR-0029,和行程無關 —— 圖形的 stash 對話框要在**已載入的列**裡找到對象(`stashNodeFor`),而側檢視列的正是不在載入範圍內的那些。同頁只省掉了「叫出面板」,沒有讓圖形找得到它沒載入的 stash。

- **跑的是 core 的那一份。** 頁面送 `sideViewStash { action, id }`,main process([sideViews.ts](../../apps/desktop/src/sideViews.ts))找出自己最後一次列出的那一筆,執行 core 的 `LISTED_STASH_ACTIONS`(`applyOrPopListedStash`、`dropListedStash`、`renameListedStash`、`copyStashName`),問題問在該 Tab 頁面的 host prompt overlay。頁面只說「第幾筆」(`id`),selector 與 SHA 都是宿主列出時的值:綁定的是使用者看到的那一筆,頁面無法指定別的(ADR-0029 的綁定規則、#334 的 `expectedHash`)。
- **互動形狀照 ADR-0029。** apply / pop 是 overlay 的 `choose` 兩顆按鈕,`Apply` 在前(`reinstateIndex: false`);drop 是只有按鈕的確認;rename 是文字輸入。不讀、也不寫 `dialogMemory`。衝突回報與失敗判定照 ADR-0030,同一份 `reportApplyFailure`。
- **選單從 `@ging/shared` 的 `STASH_ACTION_CATALOGUE` 推導**:順序、分組、`cmvKey`(`contextMenuActionsVisibility.stash.*`;rename 恆顯示)。VS Code 的 `STASH_ACTIONS` 也改由它與 core 的 `LISTED_STASH_ACTIONS` 組成,`stashMenuConsistency.test.ts` 多鎖住 package.json 的分組順序 —— 兩邊的選單不會一邊改了另一邊沒跟上。標籤沿用圖形 stash 選單的字(頁面的 `l10n`)。
- **改動 repo 的 git 包在 `runRepoMutation` 裡。** core 的 `ListedStashHost` 多了選填的 `mutate`,只包同意之後的 git,不包詢問;桌面版傳入實例的 `runRepoMutation`,所以圖形的 watcher 在執行期間靜音,結束後重繪圖形與側檢視(和 core 命令服務的改動一樣)。VS Code 不傳,行為不變。
- **它自己監看 stash 的 reflog。** 沿用 core 的 `createStashViewWatch`(common dir 下的 `logs/refs/stash`),頁面聆聽期間開啟;理由同 #333:圖形的 watcher 不看那個檔案(`isWatchedRepoPath`),drop 一筆不在最上面的 stash 只改 reflog。非遞迴的那一個 watch 是 `watchOneOnDisk`(`fs.watch`)。
- **點檔案開 `Opener.openCommitDiff`**,和 VS Code 的 Stash 側檢視一樣;桌面版在 #404 之前是 stub,先說「尚未支援」。

驗證:`packages/core/tests/extension/stashList.test.ts`(`mutate` 只包同意後的 git)、`packages/webview/tests/desktopSideViews.test.ts`(第三段、catalogue 選單與 cmv、展開與 diff 請求,不經圖形)、`apps/desktop/tests/sideViews.test.ts` 與 `graphInstance.test.ts`(main process 那一半、真 git)、`apps/desktop/e2e/sideViews.spec.ts`(外部 push 的 stash 出現、經 overlay pop)、`e2e/webview/sideViews.spec.ts`(版面)。
