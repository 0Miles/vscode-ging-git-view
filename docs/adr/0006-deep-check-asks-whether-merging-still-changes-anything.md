---
status: accepted
---

# 隨選的深度檢查問「合併它還會不會有變更」,不問「它是不是被合併的」

ADR-0002 把 squash / rebase 的偵測留給隨選檢查,並設想那是 patch-id 掃描。實際採用的是 `git merge-tree --write-tree <default branch> <branch>`:產出的 tree OID 等於 `<default branch>^{tree}`,就代表把這個分支合併進去不會改變任何內容。一次 in-memory 合併同時涵蓋 squash、rebase 與 cherry-pick,而且它**不是啟發式** —— 那是 git 自己的合併機器算出來的答案。

代價是宣稱的東西換了一件。patch-id 比對想回答的是歷史問題(它被合併過嗎),merge-tree 回答的是狀態問題(它現在還有沒有貢獻)。後者可以精確計算,前者不行,所以我們改問後者,並把這個新事實命名為 **redundant branch**(見 `CONTEXT.md`)。把改動全數 revert 掉的分支、與他人各自寫出相同修改的分支,都會被判為 redundant —— 那句話仍然是真的,它只是沒有在講歷史。

## 為什麼未來的讀者會困惑

看到用 `merge-tree` 回答「這個分支合併了沒」,第一反應是「這工具用錯了吧,不是該用 `git cherry` 嗎」——而 ADR-0002 白紙黑字寫著 #11 要用 patch 比對,更坐實了這個懷疑。差別在於問題被換掉了:一旦問的是「合併它還會不會有變更」,merge-tree 就不是近似解,而是**定義本身**。

## 考慮過但否決的方案

**完整的 patch-id 掃描(ADR-0002 原本的設想)。** 算 merge-base → 把整段差異做成單一 patch-id → 掃 default branch 歷史找同一個。真的在回答歷史問題,但它兩邊都會錯:主線在合併前後有交錯修改時 patch-id 就對不上(偽陰性),內容巧合相同時又會命中(偽陽性)。付出數次 git 呼叫加掃歷史,換到的答案還比 merge-tree 弱。

**patch-id 比對當判準。** per-commit 的 patch-id 抓得到 rebase 與 cherry-pick,但抓不到 squash(多個 commit 壓成一個,patch-id 不同)——而 squash 正是這個功能存在的理由。它沒有被丟掉,只是**降級成證據**:merge-tree 判定「有未合併變更」時,才用 `git log --right-only --cherry-mark` 把該分支自己的 commit 列出來,逐筆標示主線是否已有相同的 patch。patch-id 在那個位置錯了不致命,因為它沒有在下判決 —— 對照組就在同一個對話框裡:一個被 revert 掉的變更,每一筆 commit 都會標成「已在主線上」,而總判決仍然是未合併。

**在結果上提供刪除入口。** 最貼近使用者真正的意圖(我到底能不能刪),但 redundant **不**保證 `git branch -d` 會放行,把事實回報變成行動建議,判錯的代價就從「講了句沒用的話」升級成「資料遺失」。刪除失敗時既有的強制刪除救援流程已經接得住這個落差。

## 後果

- 結果**只在對話框裡回報**,不在分支列留下任何痕跡。這自動滿足了 ADR-0002 那條「不能混進同一個 `✓` badge」的約束,也迴避了快照過期問題 —— redundant 是隨選算的,而 `✓` 每次 refresh 都重算,兩者放在一起會有一個是舊的。
- 對話框裡每一列 commit 可以展開看完整詳細資訊,而那份資料是**點開時才抓**的。它走 `redundancyCommitDetails` 而不是既有的 `commitDetails`:後者的回應寫死在圖形展開列的比對上,不是自己要的就丟掉。
- 兩個面板共用同一條路徑:側檢視只是多一個 `RefAction`,經 `runRefActionInGraph()` 開啟圖形後在那裡跑對話框,與其他所有分支動作一致。因此**結果永遠顯示在圖形頁**,即使是從側檢視觸發的。
- **不做特例。** default branch 自己照跑,於是會得到「沒有未合併的變更」這種套套邏輯的答案。換來的是零新增 payload —— webview 目前刻意只收 `dimmedBranches`,不知道 default branch 是誰,要藏這個選單項就得把它送過去。
- 找不到 default branch 時**不**靜默停用,而是照樣顯示選單項、按下去回報原因。這與 `CONTEXT.md` 對顯示/隱藏的靜默停用約定刻意不同:靜默適合被動顯示(少一個 badge 沒人會發現),不適合主動動作(按了沒反應跟壞掉一樣)。git 低於 2.38 與兩邊無共同祖先同樣照顯示、照回報,但各自說出自己的原因 —— 「你的 git 太舊」與「這兩條歷史沒有交集」是使用者要採取的兩種不同行動。
- 相依於 `merge-tree --write-tree`(git 2.38+)。這個相依已經由 `predictConflicts` 引入,連降級路徑都是現成的。
