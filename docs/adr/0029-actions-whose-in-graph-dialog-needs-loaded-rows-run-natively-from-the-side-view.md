---
status: accepted
---

# 圖內對話框要靠已載入的列才能運作的動作,側檢視改在 host 原生執行

_與 ADR-0009 衝突:ADR-0009 說側檢視的單一分支動作一律委派給圖形 webview,會詢問的批次動作也委派;只有完全不需要詢問的才在 host 跑。drop 與 rename 都會詢問,照它的規則該委派。這篇在它旁邊劃出一塊有邊界的例外,理由是委派的前提在這塊不成立。ADR-0009 的狀態維持 accepted,本文只在它的原地加一行引用。_

**適用條件**:某個側檢視動作在圖形裡的對話框,必須先在**已載入的列**裡找到它的對象才能運作。符合這個條件的動作,側檢視不委派給圖形,而是在 extension host 用原生 UI 詢問並執行:確認用只有按鈕的 modal(`Prompts.confirm`),文字用 `showInputBox`(`Prompts.input`)。詢問的文字與判定放在 core 的 vscode-free 模組(ADR-0018),`apps/vscode` 只剩接線。

今天符合的是 Stash 側檢視的 drop 與 rename(#336),之後是 apply 與 pop(#337)。條件刻意不寫「stash」:決定 host 執行的是「對話框靠已載入的列」這件事實,不是 ref 的種類。

## 為什麼未來的讀者會困惑

- **同樣是「會詢問的單一動作」,branch 的 rename 委派給圖形,stash 的 rename 卻在 host 跑。** 看起來像是兩個人各寫各的。分界在圖形那邊的對話框靠什麼找到對象。委派過去的分支動作只拿 ref 名稱、是否為 remote、repo 三樣東西(`dispatchRefAction`),branch 清單在每次載入時整份讀進來,所以不管那條 branch 的 commit 有沒有載入,對話框都能運作。圖形的 stash 對話框則是靠 `stashNodeFor`,它只在 `this.commits`(已載入的列)裡找 `stash@{n}`:找不到時,`forStash` 會拒絕(它拿不到要綁定的 hash),rename 也沒有東西可以預填。
- **側檢視存在的理由,正好就是委派做不到的那些 stash。** #102:stash 的基底不在載入範圍內時,它不會出現在圖形上,使用者在 GING 裡就操作不到它。側檢視列的是 `git stash list` 的全部內容,與圖形載入了什麼無關。所以把它的動作委派回圖形,恰好會在側檢視要服務的那批 stash 上失敗。ADR-0009 說委派唯一的目的是不要把已有的對話框再寫一份,可是這些 stash 在圖形裡沒有能用的對話框,那個目的就落空了,剩下的只有委派的成本(把圖形面板叫到前景、webview 隱藏時掉訊息)。
- **身分規則兩邊一樣,只是綁定的時機不同。** 兩邊都送出必填的 `expectedHash`,由 backend 在執行前 `rev-parse` 比對(#334)。圖形在同意的那一刻用已載入的列再查一次(`forStash`);側檢視沒有列可以查,所以它綁定的是**對話框上寫的那個 selector**,加上該項目被列出時的 SHA,同意之後原樣送出,不再重新查詢。stash 在列出之後、或在對話框開著的時候移動了,都由 backend 拒絕(`StashMovedError`),側檢視顯示警告並重新讀取清單,和 Copy Stash Name 的規則一樣。兩邊都拒絕,不會改去作用在 hash 現在所在的位置。

## 考慮過但否決的方案

- **照 ADR-0009 委派,並讓圖形的對話框不必依賴已載入的列**(把 hash 與訊息放進委派訊息裡)。這要新增一種 stash 的委派訊息,而 ADR-0010 的 catalogue 只描述 branch。對話框也沒有已繪製的 chip 可以錨定。圖形面板還是會被叫到前景,只為了問一個側檢視自己就能問的問題。
- **先讓圖形載入那個 stash 的基底(沿用 #310 的 locate),再開圖內對話框。** 「在圖形中顯示」已經被 #333 排除在範圍外,要另開票處理。而且基底可能很舊,locate 可能要載入很深的一頁(ADR-0020:commit 載入是整個視窗一起)。
- **所有側檢視動作一律改在 host 原生執行。** 這就是 ADR-0009 否決過的方案。對 branch 而言,否決它的理由(互動形狀不一致、批次對話框要和單一對話框長在同一個地方)仍然成立,而且 branch 的委派今天能正常運作。

## 後果

- **圖形與側檢視是兩種互動形狀,這是已接受的代價。** drop 在圖形裡是 GING 自己的確認框,在側檢視是原生 modal;rename 在圖形裡是表單,在側檢視是 `showInputBox`。到了 apply / pop(#337),圖形有一個「Reinstate the index」checkbox(預設不勾),側檢視則是兩顆按鈕,`Apply` 在前(等於 checkbox 的預設)、`Apply & Reinstate Index` 在後:VS Code `^1.98` 的 stable API 沒有原生 checkbox,`Prompts.confirm` 也就只有按鈕。之後若選項多到兩三顆按鈕排不下,改用 `createQuickPick` 的 toggle 列,不要繼續加按鈕。
- **側檢視不讀、也不寫 `dialogMemory`。** 那是圖內對話框「記住我的選擇」的存放處,原生 modal 沒有對應的 UI。
- **`Prompts` 長出了 `confirm` 與 `input` 的 `value`。** 這是 ADR-0027「先有呼叫端」規則下的第一個呼叫端:`confirm` 的形狀比照 `showError`(訊息加上一串動作,回傳選中的那一個),VS Code 的實作是 `showWarningMessage` 的 modal 版本。
- **rename 的答案是空的或沒有改變,都視同取消,不執行 git。** 空的答案沿用圖形的規則。沒有改變的答案在圖形裡會照樣送出,可是 `renameStash` 會重建 commit 並 store 到 `stash@{0}`,結果只是在名字不變的情況下把 stash 移到最上面,所以側檢視不送。
- **側檢視的 stash 選單項目由 `stashActionCatalogue` 宣告**,`contextMenuActionsVisibility.stash.*` 的 context key 也從那裡產生,並有一支一致性測試鎖住 `package.json` 的 when 子句(ADR-0010 的補記)。drop 遵守 `stash.drop`;rename 沒有設定鍵,恆顯示,#333 不補鍵。
- **例外的邊界**:之後新增的側檢視動作,只有在符合上面的適用條件時才能引用這篇。圖內對話框不需要已載入的列,就照 ADR-0009 委派。
