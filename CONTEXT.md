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

Default branch 是基準;merged 與 inactive 是兩個彼此獨立的事實,一個分支可以兩者皆是、皆非、或只中其一;hidable 則由前兩者推導而來,是唯一決定畫面呈現的集合。Redundant 涵蓋 merged 涵蓋不到的那一半,但它不參與 hidable,也不改變畫面的預設呈現。以上都是算出來的事實;branch filter 則是使用者自己挑的,兩者一起決定圖形看得到什麼。

**Default branch**:
存放庫的主線分支,由 GING 偵測得來,使用者無法指定。它是判定 merged branch 與 redundant branch 的唯一基準;偵測不到時,已合併相關的顯示與隱藏靜默停用,而隨選的查詢據實回報無從判定。
_Avoid_: base branch, merge base, mainline, 主線

**Merged branch**:
tip 已經是 default branch 祖先的分支 —— 換句話說,`git branch -d` 會允許刪除它。判定純看 ancestry:squash merge 與 rebase merge 產出的分支**不算**,即使它們的內容早已進了主線。default branch 自己與其本地對應也不算。
_Avoid_: stale branch, 可刪除分支, 已合入分支

**Redundant branch**:
合併進 default branch 也不會改變任何內容的分支 —— 它已經沒有東西可以貢獻。判定只看當下內容、不看歷史,所以 squash merge 與 rebase merge 產出的分支算,把改動全數 revert 掉的、以及與他人各自寫出相同修改的也算。每個 merged branch 都是 redundant branch,反之不然;而 redundant **不**保證 `git branch -d` 會放行。
_Avoid_: absorbed branch, landed branch, 已落地分支, squash-merged branch

**Inactive branch**:
最後一個 commit 已超過門檻天數沒動的分支。與 merged branch 完全獨立 —— 剛合併的分支是 merged 但不 inactive,長年沒人碰的實驗分支是 inactive 但不 merged。
_Avoid_: stale branch, old branch, 廢棄分支

**Hidable branch**:
是 merged branch 或 inactive branch,且不在豁免名單上 —— 豁免的是 checked-out 的那個、目前被分支篩選選取的、以及符合「總是顯示」樣式的。它是唯一決定畫面呈現的集合:淡化的是它,按下隱藏會消失的也是它。merged 與 inactive 這兩個事實則各自獨立地驅動標記(badge 與年齡標籤),即使該分支被豁免也照標。
_Avoid_: dimmed branch, hidden branch

**Branch filter**:
圖形要顯示哪些分支的選集,每個存放庫一份,空集合表示顯示全部。它決定圖形讀得到哪些 commit,也是 hidable branch 的豁免來源之一。分支側檢視的選取會寫入它,但兩者**不對稱**:選取非空時必定等於 filter;filter 非空時選取卻可能是空的 —— 多選搜尋、設定帶來的開場篩選、以及切換存放庫後還原的選集,都沒有對應的樹選取。圖形工具列上的篩選標示讀的是 filter,不是選取。
_Avoid_: branch selection, selected branches

### 側檢視的選取

側檢視的選取只有一個集合,卻同時餵給兩件事:圖形要顯示什麼,以及右鍵動作要作用在誰身上。以下三個詞把「使用者選了什麼」「動作實際作用在什麼」「哪些動作能這樣作用」釘開。

**Branch selection**:
分支側檢視中被反白的 leaf 集合。folder 與 group 標題不計入 —— 它們是把 ref 依 `/` 切出來的顯示分組,在 git 裡不存在。空的選取集是使用者明確表達的「顯示全部」,不是「還沒選」。
_Avoid_: 勾選, checked branches, 篩選器, selected refs

**Action target**:
某個動作實際會作用到的分支 —— branch selection 扣掉該動作在 git 語意上不可能成立的成員(刪除扣掉 checked-out 的那個;fast-forward 扣掉遠端分支與 checked-out 的那個)。扣掉了誰一律對使用者明講,不靜默略過。只有 git 執行後才知道的失敗(未完全合併、沒有 upstream)不在扣除範圍內,那些交給 git 報錯。
_Avoid_: 選取的分支, selected branches, 有效選取

**Batch action**:
branch selection 有多個成員時,作用於整個 action target 的動作。能不能批次由 git 語意決定,不由 UI 方便與否決定 —— 只有拆得成 N 個彼此獨立、互不改變前提的操作才算。因此 delete、push、fast-forward、copy name 是 batch action;merge 與 pull 不是,序列合併第二次的基準已經被第一次改掉了。
_Avoid_: 多選動作, bulk action, 批次處理

**Batch run**:
一次 batch action 的執行過程 —— 從使用者確認、參數已定的那一刻起,經送出、結果回收、至多一輪重試(目前只有 delete 的 force 回合),到摘要收場。重試回合只涵蓋它重送的 ref,摘要一律摺疊回第一回合的完整 ref 集與原始順序;拒絕重試仍以第一回合的結果收場,不靜默關閉。同時至多一個 batch run 在飛,再開一個會被明白拒絕,不會靜默吞掉。初始確認框不屬於 batch run —— 那是各動作自己的 interface。
_Avoid_: 批次流程, batch flow, retry loop
