---
status: accepted
---

# 常駐的已合併判定只認 ancestry,squash/rebase 留給隨選檢查

Branches 側檢視與圖形隨時都在標示 merged branch,所以判定必須便宜到能掛在每一次 refresh 上:一次 `git for-each-ref --merged=<default branch> refs/heads refs/remotes` 就拿到整個集合,成本與既有的 `committerdate` 查詢同級。代價是它只認 ancestry —— **squash merge 與 rebase merge 產出的分支永遠不會被標記**,即使內容早已進了主線。

深度偵測不是不做,而是換一個觸發方式:由使用者在單一分支上主動右鍵詢問(#11)。常駐訊號便宜且零偽陽性,昂貴的 patch 比對只在被問到時才跑。

## 為什麼未來的讀者會困惑

用 GitHub squash 工作流的人會發現一個明明已經 merge 的 PR 分支沒被標記,第一反應是回報 bug。這不是 bug,是這裡刻意的分工。

## 考慮過但否決的方案

**`git cherry <base> <branch>`。** 抓得到 rebase merge 與 cherry-pick,但**抓不到 squash**(多個 commit 被壓成一個,patch-id 不同),成本卻是每個未合併分支一次 git 呼叫。付了 N 次呼叫,最主要的場景還是沒解決。

**`%(upstream:track)` 的 `[gone]`。** 「PR 合併後遠端分支被刪」在 squash 工作流下是個便宜又相當可靠的訊號,但它陳述的是「上游不見了」,不是「已經合併」。把兩件事塞進同一個標記,會讓下面那個承諾失效。

**完整 squash 偵測。** 對每個分支算 merge-base、把整段差異做成單一 patch-id、再掃 default branch 的歷史找同 patch-id。真的抓得到,但每個分支數次 git 呼叫外加掃歷史,不可能掛在每次 refresh 上。

## 後果

- 這個標記的承諾是「`git branch -d` 會放行」。任何引入偽陽性的偵測手法都會毀掉它,所以 #11 完成後,深度檢查的結果必須與 ancestry 標記在視覺上可區分,不能混進同一個 badge。
- `--merged` 的輸出含 `refs/remotes/<remote>/HEAD`,而 `%(refname:short)` 會把它縮成 `origin` —— 必須跟 `parseBranchDates` 一樣跳過 `*/HEAD`,否則清單裡會冒出一個叫 `origin` 的幽靈分支。
- 偵測不到 default branch 時整組功能靜默停用,與 `inactiveAfterDays <= 0` 的停用路徑同構。
