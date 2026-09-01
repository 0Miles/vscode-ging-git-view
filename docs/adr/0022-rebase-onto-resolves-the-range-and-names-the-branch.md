---
status: accepted
---

# rebase --onto 自己決定範圍方向,並把 tip 換成分支名

**[ADR-0023](0023-the-replay-list-decides-which-commits-move.md) 起:「哪些 commit 會被搬」不再由這個手勢表達,改由對話框的重放清單表達。** 這篇的其餘部分 —— 方向由 ancestry 判定而非點選順序、tip 送分支名所以被搬的是分支、以及那行指令要原樣印出來(`-S` 含在內)—— 一條都沒有被推翻;失效的那一條在下面「後果」裡原地標記。

圖形上 CTRL/CMD 點選兩個 commit(那個原本用來看兩者 diff 的操作)之後,對第三個 commit 按右鍵~~會多出一項 `rebase --onto`~~。**#173 起:不再多出一項 —— 既有的那一項 rebase 改變標籤與行為,改跑 `rebase --onto`;ref 選單的那一項同理。** 送出的三個參數都不是使用者直接給的:

- `<newBase>` 是按右鍵的那個 commit —— 這一個是。
- `<upstream>` 與 `<branch>` 由 [`rebaseOntoRange`](../../src/webview/utils/git.ts) 從那兩個 CTRL 選取的 commit **推導**出來:走 parent 鏈判斷誰是誰的祖先,~~祖先當 `<upstream>`~~ **(ADR-0023 起:祖先那個的 _parent_ 當 `<upstream>`,見下)**。兩條各自分岔、或祖先關係跑出已載入的 commit 之外時,退回用圖形順序(排得比較下面的比較舊)。
- `<branch>` 若有**本地分支**正好指在那個 commit 上,送出的是**分支名**而不是 hash;有多個時對話框問要哪一個,一個都沒有時才送 hash,並在對話框寫明 HEAD 會進入 detached 狀態。

對話框把最終要跑的那行 `git rebase --onto …` 原樣印出來 —— 分支還在選的時候,印的是 git 自己的 `<branch>` 佔位符,下方的選單就是填它的地方。`signing.commits` 開著時 `-S` 也會出現在那行裡,所以印出來的與跑下去的是同一件事。

**ADR-0023 起這一段仍然有效,而且變成勾選結果的函數。** 重放清單**不取代**它:清單答的是「哪些 commit」,這一行答的是「哪一個 git 指令、哪些參數、哪條分支會被搬」,兩者互補。勾選一改,印出來的那行就跟著改(`--interactive` 冒出來、下界換人、全不勾時整行消失),而印出來的與跑下去的仍然讀自同一個值。

## 為什麼未來的讀者會困惑

有兩層「使用者點了 A,程式送了 B」:

**一、兩個 commit 的先後被換掉了。** `git rebase --onto <newBase> <upstream> <branch>` 取的是 `upstream..branch`,`<upstream>` 是**開區間下界**,必須是祖先那一個 —— 給反了就會得到一個空範圍或一整片不相干的 commit。而右鍵選單拿到的兩個 hash 只是「使用者先點哪個」,那個順序不帶任何 git 語意。既然正確答案唯一,問使用者只是把責任推給他。

**二、`<branch>` 的位置塞的是分支名,不是他點的那個 commit。** 這看起來像偷換參數,但它送的是**同一個 commit 的另一種拼法** —— 而這兩種拼法在 git 裡的後果天差地別:給 hash,git 把重放後的結果留在 detached HEAD,原本的分支一動也沒動,等於憑空多一份複本;給分支名,那條分支才真的被搬過去。使用者選一段 commit 說「搬到那邊」,要的幾乎必然是後者。

順帶一提,`compareFromHash` / `compareToHash`(Commit Details View 比較兩個 commit 時算的那組)看起來就是現成答案,但它是用**畫面列號**排的,不是 ancestry。畫面順序在 `date` 排序下多半與 ancestry 一致,但那是巧合不是保證,所以 `rebaseOntoRange` 自己走一次 parent 鏈,只在走不出結果時才退回列號。

## 考慮過但否決的方案

**照字面送兩個 hash,不做任何解讀。** 最誠實,也最沒用:結果一定是 detached HEAD,而使用者得自己發現分支沒動、commit 被複製了一份。

**一律用對話框問「要移動哪條分支」,即使只有一條。** 一致,但為唯一答案多按一次。改成:只有一條就直接用、多條才問、沒有就講清楚後果 —— 問的時機對齊「真的有選擇要做」。

**把按右鍵的 commit 也允許是那兩個之一。** `--onto` 的目標若正是範圍的兩端之一,得到的是空操作或自我複製。~~這種情況直接不顯示選單項~~,而不是讓它跑出一個看不懂的結果。**#173 起:選單項不會消失 —— 它退回成普通的 rebase(那一項本來就一直在)。否決的理由沒有變:不讓 `--onto` 指向自己範圍的端點。**

**用 `git merge-base --is-ancestor` 去問 git,而不是走已載入的 commit。** 準確,但要多跑一趟行程才能決定一個選單項該長什麼樣。已載入的 commit 圖已經在手上,而它答不出來時的退路(圖形順序)本來就存在。

## 後果

- **這一項只在「正在比較兩個 commit」時存在。** 它的範圍來自 Commit Details View 的比較狀態(`comparedCommitPair`),所以關掉比較、或只展開單一 commit 時,選單上不會有它。這是把一個既有的選取手勢再用一次,不是新增一種選取模式。
  **#173 起改為:它不再是自己一項。** 比較兩個 commit 時,commit 選單與 ref 選單**既有的**那一項 rebase 改變標籤與行為去重放這個範圍;沒有比較時兩項照舊。獨立的「Rebase the Selected Commits onto this Commit」已移除 —— 手勢已經做完了,不必再讓使用者在兩個選單項之間挑一個。ref 選單那一項的新基底是使用者按的那條 branch(送出的是分支名,不是它底下的 hash)。側檢視的 rebase 一律維持普通那個:它的標籤寫死在 package.json 裡跟不動,而決定範圍的手勢只在圖形上看得見。
- **範圍可能不是一條直線。** 兩個 commit 不互為祖先時仍會送出 —— `upstream..branch` 對分岔的兩條一樣是合法的 rev range,~~只是使用者要自己看懂算出來的是什麼。對話框印出的那行指令就是為此存在。~~
  **ADR-0023 起:「使用者要自己看懂」失效。** 實測顯示它不成立 —— 範圍跨 merge 時 git 靜默丟掉 merge、把菱形壓成直線、把側枝的 commit 複製一份重放,而側枝的分支標籤留在原地,那行指令對這幾件事一個字都沒有說。對話框現在把 git 真的會重放的每一筆列出來、逐筆可勾,壓平的後果與會留在原地的分支另外用文字講明。**那行指令本身沒有被取代**,見上方開頭的補記。
- **`rebaseOnto` 與既有的 `rebaseOn` 是兩個 action,不共用。** `rebaseOn` 搬的是**目前 checked-out 的分支**,`rebaseOnto` 搬的是使用者指定的那一段,兩者的參數與後果都不一樣。錯誤回報共用 `error.unableToRebase`。
- ~~**`contextMenuActions.commit.rebaseOnto` 可以單獨關掉**,與 `rebase` 分開 —— 覺得這項太危險的人不必連帶失去一般的 rebase。~~
  **#173 移除了這個設定鍵。** 兩種 rebase 合成同一個選單項之後,「只關掉其中一種」已經沒有東西可以指:能關的是那一項,而它由 `contextMenuActions.commit.rebase` 控制。留著這個鍵只會承諾一件沒有任何程式碼會做的事。
- **簽章設定照舊生效,而且看得見。** `signing.commits` 開著時帶 `-S`,和其他會產生新 commit 的 action 一致;為了讓預覽不說謊,這個設定被加進 `viewState`,webview 才知道要不要印那個旗標。
