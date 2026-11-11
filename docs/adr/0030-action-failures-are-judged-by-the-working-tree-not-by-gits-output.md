---
status: accepted
---

# 會留下半套狀態的動作,失敗時依工作目錄的狀態判定,不解析 git 的輸出

一個動作如果可能停在一半——跑完了,卻留下衝突——它有沒有成功、停在哪裡,一律看**工作目錄的狀態**:執行前、後各讀一次 unmerged 路徑(`diff --name-only --diff-filter=U`,core 的 `unmergedFiles`),不讀 git 印了什麼。判定放在 core,在 host 端做;圖形與側檢視收到的是同一份結果,各自用同一組 l10n 字串回報。

今天的呼叫端是 stash 的 apply 與 pop(#337,`StashApplyFailure`):

- 執行前已經有 unmerged 路徑:拒絕,不跑 stash 指令。
- 執行後有 unmerged 路徑:有衝突,stash 仍保留,位置用它的 SHA 重新查出來。
- 執行後沒有、但指令失敗:沒有變更。

## 為什麼未來的讀者會困惑

- **git 明明說了發生什麼事,為什麼不讀?** 因為那是給人看的文字,不是介面:會隨版本、語系(`LANG`)、`advice.*` 設定改變,同一件事在 stdout 還是 stderr 也不固定。工作目錄的狀態是 git 自己之後也要讀的東西,穩定得多。
- **「結束碼不是 0」也不夠。** 有衝突的 `git stash apply` 以非零結束,但報告只寫在 stdout,simple-git 會把它當成功 resolve。#337 之前,圖形就因此把衝突的 apply 說成成功,一句話也沒有。所以就算指令「成功」,執行後也一樣要讀一次。
- **執行前的那次讀取,不是多餘的。** 工作目錄如果本來就有衝突(例如 merge 到一半),git 會拒絕 apply(`needs merge`),而那些衝突仍然留著;只看執行後,就會把它們誤報成這筆 stash 造成的。執行前讀一次,才分得出「本來就有」和「這次造成的」。
- **執行前的檢查只是縮小空窗,不是關閉。** 讀完到真正執行之間,工作目錄仍然可能改變;這和 #365 讓 apply 依 SHA 執行、保證套用內容是同一件事以外的另一個空窗。

## 考慮過但否決的方案

- **解析 git 的輸出(`CONFLICT (content)`、`needs merge`、`would be overwritten`)。** 理由見上。`formatGitError` 仍然會挑出 git 的一行附在訊息下面給人看,但不拿它做判斷。
- **只看結束碼。** 見上:有衝突的 apply 在 simple-git 眼裡是成功。
- **在 webview 裡判定。** webview 拿到的 `status` 已經被 `formatGitError` 縮成一行,也讀不到工作目錄;判定只能在 host 做,所以和既有的 response extras(`notFullyMerged`、`movedSelector`)一樣,以事實的形式跨過 bridge。

## 後果

- **有一種情況分不出來。** pop 的 apply 成功、drop 卻失敗時,工作目錄沒有 unmerged 路徑,會被說成「沒有變更」,其實已經套用了。要分辨就得讀 git 的輸出,這裡選擇不讀,並寫在 `StashApplyFailure` 的註解裡。
- **讀不到工作目錄時,沿用指令本身的結果。** 指令失敗就照 git 的錯誤回報,成功就算成功;不會在不知道的時候說「沒有變更」。執行後查 stash 位置失敗時,只把位置降成「已不在清單中」,衝突照樣回報。
- **之後的動作**——cherry-pick、revert、merge、rebase 這類會停在衝突上的——要回報衝突時,照這個做法:在 core 讀前後狀態,把結果當成事實送給兩邊,不在 webview 解析字串。今天它們靠的是 `operationState` 的衝突橫幅,還沒有改。
