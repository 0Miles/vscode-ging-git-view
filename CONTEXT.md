# GING

一個 VS Code 擴充功能,在編輯器內顯示 git commit 圖形,並整合原生的原始檔控制側邊欄。

工作區裡常同時開著多個存放庫,而「目前是哪一個存放庫」這件事在 VS Code 和 GING 各有一套答案,兩者不一定一致。以下詞彙就是為了把它們釘開。

## Language

### 存放庫的身分

**Focused repository**:
使用者在原生「原始檔控制存放庫」清單中選取的那個存放庫。同一時間**至多一個** —— 該清單的多選改變的是哪些存放庫可見,不是誰被聚焦。VS Code 只在它**改變**時通報,重複選取同一個不會有任何訊號。
_Avoid_: selected repository, current repository

**Active repository**:
VS Code 整體認定的當前存放庫 —— 取 focused repository 與「作用中編輯器所屬存放庫」兩者中較晚變動的那一個。它決定狀態列、變更數徽章等原生 UI 顯示誰。擴充功能無法指定它。
_Avoid_: current repository, focused repository

**Current repository**:
GING 正在處理的存放庫 —— 圖形顯示它,分支與 remote 側檢視也一併跟隨它。它會跨工作階段保存,所以重新開啟的面板會回到同一個存放庫。它與 focused repository 各自獨立:通常同步,但在圖形內自行切換存放庫時就會分岔,而 GING 無法把 focused repository 拉回來對齊。
_Avoid_: graph repository, active repo, last active repo

**Known repository**:
GING 已探索並納入管理的存放庫。來源有二:工作區搜尋,以及內建 git 擴充功能已開啟的所有存放庫(含 submodule 與 worktree)。只有 known repository 能出現在存放庫選單中,但明確指名的路徑仍可繞過此集合直接開啟。
_Avoid_: discovered repo, tracked repo

### 分支的狀態

Default branch 是基準;merged 與 inactive 是兩個彼此獨立的事實,一個分支可以兩者皆是、皆非、或只中其一;hidable 則由前兩者推導而來,是唯一決定畫面呈現的集合。

**Default branch**:
存放庫的主線分支,由 GING 偵測得來,使用者無法指定。它是判定 merged branch 的唯一基準;偵測不到時,已合併相關的顯示與隱藏全部靜默停用。
_Avoid_: base branch, merge base, mainline, 主線

**Merged branch**:
tip 已經是 default branch 祖先的分支 —— 換句話說,`git branch -d` 會允許刪除它。判定純看 ancestry:squash merge 與 rebase merge 產出的分支**不算**,即使它們的內容早已進了主線。default branch 自己與其本地對應也不算。
_Avoid_: stale branch, 可刪除分支, 已合入分支

**Inactive branch**:
最後一個 commit 已超過門檻天數沒動的分支。與 merged branch 完全獨立 —— 剛合併的分支是 merged 但不 inactive,長年沒人碰的實驗分支是 inactive 但不 merged。
_Avoid_: stale branch, old branch, 廢棄分支

**Hidable branch**:
是 merged branch 或 inactive branch,且不在豁免名單上 —— 豁免的是 checked-out 的那個、目前被分支篩選選取的、以及符合「總是顯示」樣式的。它是唯一決定畫面呈現的集合:淡化的是它,按下隱藏會消失的也是它。merged 與 inactive 這兩個事實則各自獨立地驅動標記(badge 與年齡標籤),即使該分支被豁免也照標。
_Avoid_: dimmed branch, hidden branch
