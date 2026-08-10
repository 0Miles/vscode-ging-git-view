---
status: accepted
---

# 沒有開啟資料夾的視窗,圖形一律不自己出現

GING 只在 `vscode.workspace.workspaceFolders` 非空的視窗裡**自行**開啟圖形。這條閘門是 [graphPanelWindow.ts](../../src/extension/graphPanelWindow.ts) 的 `mayOpenGraphUnprompted`,擋住兩條自動路徑:跟隨 focused repository 的 `onDidChangeSelection`,以及 `WebviewPanelSerializer` 還原上一輪留下的面板。明確的指令(`ging-git-view.view`、側邊欄的存放庫列、SCM 標題圖示)不受影響 —— 空視窗裡叫得出來就開得出來。

## 為什麼未來的讀者會困惑

第一直覺是「空視窗本來就沒有 known repository,這條檢查是多餘的」。**恰恰相反,空視窗有 known repository,那正是問題所在。** 內建 git 擴充功能會從開啟中的檔案、以及 `git.openRepositoryInParentFolders` 的父層探測拿到存放庫,`mirrorBuiltinIntoRepoManager` 再把它們併進 repoManager。於是一個「什麼資料夾都沒開」的視窗照樣走完 `toKnownRepos` 的過濾、照樣拿到一個 focused repository,圖形就這樣自己彈出來 —— 而且顯示的是使用者上一次工作的存放庫,看起來像是視窗之間串了狀態([#32](https://github.com/0Miles/vscode-ging-git-view/issues/32))。

改用「known repository 為空」當條件因此無效:那個集合在出問題的當下是**非空**的。

## 考慮過但否決的方案

**在 tracker 端加一段啟動沉澱窗。** [scmRepoTracker.ts](../../src/extension/scmRepoTracker.ts) 只靜默吸收綁定當下就已存在的選取,而冷啟動時那通常是空的 —— 內建 git 還沒探測完。之後的「第一個存放庫取得焦點」與「還原上一輪的焦點」都是正常的變更事件,照樣 fire。用計時器把開頭幾百毫秒吃掉能擋住,但那是拿某一台機器的探測耗時當常數,已在 tracker 的註解裡明確拒絕過一次,這裡不重開。

> [ADR-0001](0001-refocusing-the-graph-uses-an-explicit-row-button.md) 的「後果」寫 tracker 刻意不為啟動時的初始選取 fire `onDidChangeSelection`,兩者不衝突但容易誤讀:靜默的只有**綁定那一刻已經在位**的選取。冷啟動時那通常什麼都不是,所以啟動過程照樣有事件流出來 —— ADR-0001 為 focused repository context key 補掛 `onDidChangeRepos` 的理由仍然成立,本 ADR 擋的是那些事件裡「自行開啟圖形」的那一段。

**只擋 tracker,不擋還原路徑。** 還原一個使用者自己開過的面板,說它是「自動」有點苛。但兩條路徑在使用者眼裡是同一件事(圖形沒被叫就出現了),而分頁還原是跨工作階段的 —— 空視窗裡開過一次,之後每次重開都會再冒出來,正是這個 issue 抱怨的形狀。兩條走同一條規則。

## 後果

- **空視窗裡手動開的圖形不會被還原。** 指令開得出來,但重啟 extension host 或重開視窗後那個分頁會被 `deserializeWebviewPanel` 丟掉。這是刻意的取捨,不是漏掉的例外。
- **這條閘門不影響已經開著的面板。** focused repository 變更時,已開啟的圖形照樣就地切換存放庫並 reveal —— 那不是「自己出現」,而是跟隨。
- **判斷依據是 workspace folder,不是 known repository。** 之後若想改成更聰明的條件,先確認它在「空視窗 + 內建 git 已探測到存放庫」這個組合下仍然為偽,否則就退回原本的 bug。
