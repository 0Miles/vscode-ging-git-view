---
status: accepted
---

# 上下鍵在列之間移動焦點,捲動交給 Page Up / Page Down

圖形的 commit 表格是一個 `role="grid"`:每一列可 focus,整張表共用一個 tab stop(roving tabindex),`ArrowUp` / `ArrowDown` **在列之間移動焦點**,`ArrowLeft` / `ArrowRight` 走進列內的 ref 標籤與欄位表頭。捲動視窗改由 `PageUp` / `PageDown` 負責。Commit Details View 開著時,焦點移到哪一列就載入哪一列的 commit —— selection follows focus。

這是把 [#13](https://github.com/0Miles/vscode-ging-git-view/issues/13) 的來源元素可 focus 化做完之後,必然要回答的問題:列一旦進了 tab order,上下鍵照 grid 慣例就該移動焦點,而它們原本是捲動畫面 48px。

## 為什麼未來的讀者會困惑

**「上下鍵不捲動」會被當成 bug 回報。** 這是使用者可感知的行為變更,不是實作細節 —— 舊的肌肉記憶(按住 Down 讓畫面往下滑)在這之後會改成「焦點一列一列往下走,視窗跟著焦點捲」。收到這類回報時請確認是不是這條決定,而不是急著把 `window.scrollBy` 加回上下鍵。

**`commitDetailsNavigate` 不見了。** 它原本是「CDV 開著時,上下鍵切換到上/下一個 commit,否則回傳 false 讓畫面捲動」。那個「否則」正是舊的雙模式:同一顆鍵依 CDV 是否開啟做兩件事。現在只剩一件事 —— 移動焦點 —— 而 CDV 的切換變成 `focusGraphRow` 的副作用。行為在 CDV 開著時完全相同,函式本身則沒有存在的理由了。

**`Ctrl`/`Cmd` + 上下鍵沒有變。** 那組是沿 graph 走 parent / child(`commitDetailsNavigateGraph`),與這條決定正交,不要一起改。

## 考慮過但否決的方案

**只有焦點在列上時才做列間移動,焦點在 body 時維持捲動。** 相容性最好,而且這種模式分歧在改動前就已經存在(`commitDetailsNavigate` 就是照「CDV 是否開啟」分岔)。否決的是它把一顆鍵的意義綁在「焦點現在在哪」上,而焦點在 body 時畫面**沒有任何指示** —— 使用者分不清自己在哪個模式,只會覺得同一顆鍵有時捲動有時不捲。既然要把列放進 tab order,不如讓上下鍵只有一個意思。

**加一個設定開關讓使用者選。** 多一個要維護、要寫進四份 nls、要在兩條路徑都測的設定,換來的只是迴避一次判斷。而且兩種行為都會有人依賴之後,就再也拿不掉了。

**Page Up / Page Down 改成一次移動一頁的焦點(VS Code 清單的做法)。** 更貼近 grid 慣例,但捲動就徹底沒有鍵盤入口了 —— 而「只想掃一眼下面有什麼、不想動選取」是看 git 圖形時很常見的動作。留給它一顆鍵。

## 後果

- **焦點與捲動位置可能分岔。** Page Up / Page Down 只捲動畫面,焦點留在原處;此時按一下方向鍵,`scrollIntoView({ block: "nearest" })` 會把畫面拉回焦點所在的列。這是刻意的:捲動是瀏覽,方向鍵是操作,操作要回到操作的位置。
- **上下鍵一律 `preventDefault`。** 焦點在 body 時它們也不再捲動,而是從第一列(或最後一列)進入 grid。想在圖形上「純捲動」只剩 Page Up / Page Down 與滑鼠滾輪。
- **selection follows focus 會發請求。** CDV 開著時按住 Down,每一列都會送出一次 `commitDetails`。這與改動前逐列按 Down 的行為相同(`commitDetailsNavigate` 每次也呼叫 `loadCommitDetails`),沒有新增節流。
- **彈出層必須先攔截鍵盤。** 右鍵選單早就在 document keydown 的最前面 return;repo 下拉選單原本沒有,因為上下鍵只是捲動、傷害有限。現在上下鍵會**移動焦點**,不攔就會把焦點從剛打開的下拉選單底下抽走 —— 所以 keydown handler 多了一條「下拉選單開著就整段跳過」的閘門。日後再加彈出層,同一條閘門要一起加。
- **未做:`Home` / `End` 不動。** grid 慣例是跳到第一/最後一列,但那會蓋掉瀏覽器原生的捲到頂/底,而這次的範圍是把選單變成鍵盤可達,不是把整張表補成完整的 grid。要補的話連 `Ctrl+Home` 一起想。
