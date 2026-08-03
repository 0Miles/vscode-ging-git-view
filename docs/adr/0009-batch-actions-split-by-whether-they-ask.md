---
status: accepted
---

# 批次動作依「是否需要詢問使用者」決定在哪個行程執行

側檢視的**單一**分支動作一律委派給圖形 webview 執行(`runRefAction`)。**批次**動作不照抄這條規則,而是分流:任何會跳出確認、或需要選參數的批次動作(delete、push、fast-forward)仍然委派給 webview,並為批次**新寫**一組對話框(不是把單一對話框跑 N 次);完全不需要詢問的(copy name)直接在 extension host 跑完,不驚動圖形面板。

## 為什麼未來的讀者會困惑

`copyName` 的批次實作在 `src/extension.ts`,`delete` 的批次實作在 `src/webview/main.ts` —— 同一個右鍵選單上的兩個項目落在兩個不同的行程裡,看起來像是有人偷懶沒統一。

分流的理由是**委派的正當性有邊界**。委派存在的唯一目的,是不要把圖內選單已經有的對話框再寫一份(見 `extension.ts` 的 `runRefActionInGraph` 註解)。對單一動作,這個理由成立。但批次對話框在圖內**根本不存在**,所以「沿用」對批次不成立;剩下的只有委派的成本:`openGraphView()` 會把圖形面板叫到前景,而 webview 隱藏時會掉訊息(沒開 `retainContextWhenHidden`),現有的 `pendingRefAction` + `seq` 雙路投遞就是為了補償這件事。對一個「連 UI 都不需要」的動作付這個成本是純虧。

界線畫在「**是否需要詢問**」,而不是「是否危險」或「是否有參數要選」:確認框本身就是 UI,一旦要 UI,就該和圖內的對話框長在同一個地方,共用同一套樣式與 `showActionRunningDialog` 的行為。fast-forward 在 git 語意上不可能造成損失(`git fetch . <upstream>:<branch>` 拒絕非 fast-forward 更新,要嘛成功要嘛報錯),但它有一個確認框,所以照樣走 webview。

## 考慮過但否決的方案

**批次一律改在 extension host 原生執行。** 側邊欄操作不再彈出圖形,而且批次確認框剛好就是 issue #12「清理遺留分支對話框」需要的那個 UI,兩者可以共用。(文案不是問題:webview 的字串全部由 `src/extension/webviewL10n.ts` 以 `l10n.t()` 從同一份 `l10n/bundle.l10n.json` 投影過去,host 與 webview 本來就共用一套 l10n。)否決原因是**互動形狀**:原生 modal 只有按鈕、沒有 checkbox,批次刪除的「強制刪除」與「同時刪除遠端」在原生只能攤成多顆按鈕或兩段式 QuickPick。單一刪除與批次刪除並排在同一個右鍵選單上,卻是兩種互動形狀,使用者會讀成兩個不同的功能。

**批次一律委派給 webview。** 一致,但為了複製 5 個分支名而把整個圖形面板叫到前景。

**多選時保留 checkout / rename / rebase 等不可批次的動作,讓它們作用於右鍵那一項。** 否決:同一個選單裡有些項針對 5 條、有些針對 1 條,而標籤上分辨不出來 —— 這正是這次要消滅的不一致。多選時那些項一律隱藏,代價是想對其中一條做單一操作時要先單擊還原成單選。

## 後果

- **選單的單一/批次切換用 VS Code 內建的 `listMultiSelection`,不自己維護 context key。** 已對 1.131.0 的 `workbench.desktop.main.js` 查證:該 key 在 list 與 tree 兩處各綁定一次,於 `onDidChangeSelection` 內以 `bufferChangeEvents` **同步**寫入 `selection.length > 1`。這正是不自己做的理由 —— 我們的 `setContext` 是非同步的,會和右鍵選單的渲染搶時序。
  這件事沒有自動測試守著:`_getContextKeyInfo` 不對擴充功能開放(實測 `command '_getContextKeyInfo' not found`),而 TreeView 沒有任何 API 能程式化地做出多選,所以整合測試也造不出這個狀態。升級 VS Code 目標版本時請手動確認,或用「Developer: Inspect Context Keys」現場檢查。
- **批次不提供「記住我的選擇」。** `dialogMemory` 存在 `extensionState`、host 讀得到,不是做不到;是批次刪除本來就該每次重新確認。
- **issue #12 的待決問題要照這條 ADR 重新回答。** 那張票傾向「從側檢視進入的話原生 QuickPick 比較自然」,但若它要沿用這裡的批次刪除,對話框就得長在 webview 裡。
- 批次刪除是新的 `deleteBranches` 請求(host 端迴圈、每個 ref 回傳一筆結果),不是從 webview 送 N 個 `deleteBranch`。連帶必須把 `getRemotes()` 提到迴圈外,否則「同時刪除遠端」會退化成 N×M 次 `ls-remote`。
- 「未完全合併」的 force 補救從「每條一個對話框」改成「第一輪跑完,把因此失敗的收集起來,用**一個**對話框問要不要強制刪除」。安全網保住,對話框數量不隨選取數成長。
