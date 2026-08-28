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

Default branch 是基準;merged 與 inactive 是兩個彼此獨立的事實,一個分支可以兩者皆是、皆非、或只中其一;hidable 則由前兩者推導而來,是唯一決定淡化與隱藏的集合。Redundant 涵蓋 merged 涵蓋不到的那一半,但它不參與 hidable,也不改變畫面的預設呈現。Cleanup candidate 由三個事實一起推導,決定的卻是另一件事 —— 提議刪除誰;它與 hidable 的豁免規則只差一項,兩者不可互換。以上都是算出來的事實;branch filter 則是使用者自己挑的,兩者一起決定圖形看得到什麼。

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
是 merged branch 或 inactive branch,且不在豁免名單上 —— 豁免的是 checked-out 的那個、目前被分支篩選選取的、以及符合「總是顯示」樣式的。它是唯一決定淡化與隱藏的集合:淡化的是它,按下隱藏會消失的也是它。merged 與 inactive 這兩個事實則各自獨立地驅動標記(badge 與年齡標籤),即使該分支被豁免也照標。分支側檢視表達完整的 hidable;圖形只表達其中 merged 的那一半 —— inactive 是側檢視的降噪概念,圖形不隱藏任何東西,也不淡化長期沒動的分支。圖形仍**認得** inactive,但那份知識只決定清理入口出不出現在右鍵選單上,不影響任何渲染。豁免規則兩面共用,所以同一個分支不會一面淡、一面不淡。
_Avoid_: dimmed branch, hidden branch

**Cleanup candidate**:
被提議刪除的分支 —— merged、redundant、inactive 三個事實至少中一個,且不在豁免名單上(checked-out 的那個、default branch 與其同名本地分支、符合「總是顯示」樣式的)。它與 hidable branch **只差在 branch filter**:hidable 豁免篩選中的分支,candidate 不豁免 —— 篩選裡裝的常常正是要刪的那幾條。它只是**提議**,不宣稱分支的任何性質:成員的安全強度天差地別,merged 有 `git branch -d` 的保證,redundant 沒有,inactive 對「刪掉會不會損失東西」完全沒有說任何話。redundant 成員只在使用者明確要求深度檢查後才出現,所以同一個 repo 的候選集合會在使用者眼前變長。
_Avoid_: deletable branch, disposable branch, stale branch, 可刪除分支, 遺留分支

**Branch filter**:
圖形要顯示哪些分支的選集,每個存放庫一份,空集合表示顯示全部。它決定圖形讀得到哪些 commit,也是 hidable branch 的豁免來源之一。分支側檢視的選取會寫入它,但兩者**不對稱**:選取非空時必定等於 filter;filter 非空時選取卻可能是空的 —— 多選搜尋、設定帶來的開場篩選、以及切換存放庫後還原的選集,都沒有對應的樹選取。圖形工具列上的篩選標示讀的是 filter,不是選取。
_Avoid_: branch selection, selected branches

### Ref 的兩種形

同一條分支有兩種寫法,差別只在 `remotes/` 前綴 —— 但兩種寫法的職責截然不同,混用就會出現「`origin/main` 到底是遠端分支還是撞名的本地分支」這種歧義。

**Canonical ref**:
分支在 git 裡的完整身分(`main`、`remotes/origin/main`)。`remotes/` 前綴本身就是「這是遠端分支」這件事實,不需要旁邊再放一個布林重述一次。凡是把 ref 當**輸入**傳遞 —— 元件之間、行程之間 —— 一律用這個形。
_Avoid_: branch-list format, full ref, 完整分支名

**Display ref**:
canonical ref 的呈現形 —— 剝掉 `remotes/` 前綴(`origin/main`),與畫面上的標籤一字不差。只存在於輸出端:畫面、對話框、剪貼簿。它永不回流當輸入:本地分支可以真的叫 `origin/main`,前綴一剝,身分就丟了。
_Avoid_: short name, ref label, 顯示名稱

### Pull request 的落點

**Pull request provider**:
一台 host 上跑的是哪一種 forge —— GitHub、GitLab、Bitbucket、Gitea/Forgejo,或一段自訂 URL 樣板。它是 **host 的性質,不是 repo 的、也不是 remote 的**:同一台自架主機上的所有 repo 共用一筆。「建立 pull request」據此決定要開哪個 URL;查不到就據實回報並提議設定那個 host,不猜。五個公開 host 內建,同名 host 的設定整筆取代內建那筆(ADR-0018)。
_Avoid_: PR host, git host, remote provider, PR 服務

### 側檢視的選取

側檢視的選取只有一個集合,卻同時餵給兩件事:圖形要顯示什麼,以及右鍵動作要作用在誰身上。以下三個詞把「使用者選了什麼」「動作實際作用在什麼」「哪些動作能這樣作用」釘開。

**Branch selection**:
分支側檢視中被反白的 leaf 集合。folder 與 group 標題不計入 —— 它們是把 ref 依 `/` 切出來的顯示分組,在 git 裡不存在。空的選取集是使用者明確表達的「顯示全部」,不是「還沒選」。
VS Code 從 TreeView 回報的原始選取集**含** folder 與 group 標題,因此不等於 branch selection:只反白 folder 時,原始集合非空而 branch selection 是空的。兩者之間的轉換由 `branchSelectionOf` 負責;問「有沒有選到分支」一律以它的結果為準,不是原始集合的大小。
_Avoid_: 勾選, checked branches, 篩選器, selected refs

**Action target**:
某個動作實際會作用到的分支 —— **來源集合**扣掉該動作在 git 語意上不可能成立的成員(刪除扣掉 checked-out 的那個;fast-forward 扣掉遠端分支與 checked-out 的那個)。來源有二:**branch selection**,以及清理對話框裡被勾選的 **cleanup candidate**;後者的豁免已先排除 checked-out,所以那條路的扣除恆為空。扣掉了誰一律對使用者明講,不靜默略過。只有 git 執行後才知道的失敗(未完全合併、沒有 upstream)不在扣除範圍內,那些交給 git 報錯。
_Avoid_: 選取的分支, selected branches, 有效選取

**Batch action**:
branch selection 有多個成員時,作用於整個 action target 的動作。能不能批次由 git 語意決定,不由 UI 方便與否決定 —— 只有拆得成 N 個彼此獨立、互不改變前提的操作才算。因此 delete、push、fast-forward、copy name 是 batch action;merge 與 pull 不是,序列合併第二次的基準已經被第一次改掉了。
_Avoid_: 多選動作, bulk action, 批次處理

**Batch run**:
一次 batch action 的執行過程 —— 從使用者確認、參數已定的那一刻起,經送出、結果回收、至多一輪重試(目前只有 delete 的 force 回合),到摘要收場。重試回合只涵蓋它重送的 ref,摘要一律摺疊回第一回合的完整 ref 集與原始順序;拒絕重試仍以第一回合的結果收場,不靜默關閉。同時至多一個 batch run 在飛,再開一個會被明白拒絕,不會靜默吞掉。初始確認框不屬於 batch run —— 那是各動作自己的 interface。
_Avoid_: 批次流程, batch flow, retry loop

### 圖形載入的 commit

圖形一次只讀歷史的一段,而「這一段有多長」是一個會被使用者撐大、也會被導覽悄悄彈回去的量。它決定圖形畫得出什麼,也決定搜尋找得到什麼。

**Loaded commit window**:
圖形當下向後端索取的 commit 筆數上限。它只會因為明確的請求而變大 —— 按下載入更多、或搜尋為了觸及匹配的 commit 而擴大 —— 只會整個彈回開場筆數而變小,不會停在中間值。縮回有兩條路:圖形頁尾那個唯一為此而設的重設入口,以及四種為了別的目的而做、順帶把視窗清掉的導覽 —— 換存放庫、換分支篩選、切換遠端分支顯示、變更 commit 排序。它跨面板重載保存,而面板每次重新變得可見就是一次重載,所以撐大的視窗會一路跟著使用者回來;正因如此,它一超過開場筆數,頁尾就顯示它當下的數值與一個把它縮回去的控制項,停在開場筆數時則什麼都不顯示。
_Avoid_: page, 分頁, commit 快取, maxCommits(那是實作名)
