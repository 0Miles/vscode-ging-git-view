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
跨工作階段保存下來的是一個**路徑字串**,不是一個保證仍然成立的存放庫 —— 目錄可能在兩次工作階段之間被刪除,或不再掛載。字串到 current repository 的解析由 `resolveCurrentRepo` 負責;問「現在的 current repository 是誰」一律以它的結果為準,不是 `workspaceState` 裡存著的東西。解析不通過時它是 `null`,而那個字串**留著不刪** —— 沒有任何探測能把「已被刪除」與「現在連不上」分開。
_Avoid_: graph repository, active repo, last active repo

**Known repository**:
GING 已探索並納入管理的存放庫。來源有二:工作區搜尋,以及內建 git 擴充功能已開啟的所有存放庫(含 submodule 與 worktree)。只有 known repository 能出現在存放庫選單中,但明確指名的路徑仍可繞過此集合直接開啟。
這個集合同樣是跨工作階段保存的,所以它也可能列著已經不存在的目錄 —— 集合成員的身分不等於路徑仍然可用,兩者一樣由 `resolveCurrentRepo` 那組判準來分。圖形開機時要落在哪一個存放庫,由 host 端的 `pickBootRepo` 決定後送給 webview;webview 不從這個集合裡自己挑,它拿不到檔案系統。
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
一台 host 上跑的是哪一種 forge —— GitHub、GitLab、Bitbucket、Gitea/Forgejo,或一段自訂 URL 樣板。它是 **host 的性質,不是 repo 的、也不是 remote 的**:同一台自架主機上的所有 repo 共用一筆。「建立 pull request」據此決定要開哪個 URL;查不到就據實回報並提議設定那個 host,不猜。五個公開 host 內建,同名 host 的設定整筆取代內建那筆(ADR-0021)。
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
一次 batch action 的執行過程 —— 從使用者確認、參數已定的那一刻起,經送出、結果回收、至多一輪重試(目前只有 delete 的 force 回合),到摘要收場。重試回合只涵蓋它重送的 ref,摘要一律摺疊回第一回合的完整 ref 集與原始順序。

收場有**三種**,三種都報出第一回合做了什麼,沒有一種靜默關閉:結果回收完;使用者**拒絕**重試;以及重試的詢問在被回答之前就從畫面上消失 —— 最後這種是 **abandoned run(被放棄的 run)**。會有第三種,是因為對話框只有一格,任何背景訊息舉起的對話框都直接蓋掉它,而被蓋掉時「答應」與「拒絕」兩個出口都不會有人走。abandoned run 的摘要是**欠著的**:蓋掉詢問的那個對話框留在畫面上(它通常是使用者剛提出的請求,蓋回去等於把請求弄丟),摘要等對話框那一格再次空出來才補上;圖形則在 run 結束的當下就重新整理,因為它說得出哪些分支不見了,說不出剩下的為什麼還在。

同時至多一個 batch run 在飛,再開一個會被明白拒絕、不靜默吞掉 —— **唯一的例外**是停在重試詢問上、而那個詢問已經不在畫面上的那個 run:它被讀成已經結束,新的 batch 照常開始。代價是它第一回合的結果沒有地方報,所以這只是 abandon 漏接時的最後一道防線,不是主要的收場方式。初始確認框不屬於 batch run —— 那是各動作自己的 interface。
_Avoid_: 批次流程, batch flow, retry loop

### 圖形載入的 commit

圖形一次只讀歷史的一段,而「這一段有多長」是一個會被使用者撐大、也會被導覽悄悄彈回去的量。它決定圖形畫得出什麼,也決定搜尋找得到什麼。而導覽本身則決定圖形讀的是**誰的**歷史 —— 兩者一起答完「畫面上這些 commit 是哪來的」。

**Navigation**:
改變「哪些 commit 該在畫面上」的操作 —— 換存放庫、換分支篩選、切換遠端分支顯示、變更 commit 排序、隱藏/顯示個別 remote、從 Repository Settings 抽屜變更載入範圍,以及在 VS Code 設定裡改了一個當下存放庫沒有覆寫的 Repository Setting 預設值。共同的性質不是清掉 loaded commit window(見下,清不清由**抵達的路**決定,不由是哪一種導覽決定),而是**不得靜默落空**:圖形上的 commit 永遠屬於當下的存放庫與當下的篩選,不存在「設定改了、畫面沒跟上,而且沒有人會來收拾」這種狀態。它與 refresh 的分野正在這裡 —— refresh 問的是同一個問題,落空了自有下一次載入把答案帶回來;導覽問的是另一個問題,落空就沒有人會再問。載入進行中發生導覽時,除了 commit 排序由面板自己的選單改時出聲拒絕、什麼都不動之外,其餘都作廢在飛的載入並立刻重新請求。兩條出路的分野是**拒絕得起還是拒絕不起** —— 送出載入之前狀態已經動了的,只能作廢。第五種還多一層:它不是一次呼叫,而是 host 改寫 repo state 後送回來的一個事實,面板靠比對那些會餵進載入請求的欄位認出它(ADR-0024)。預設值那一種同樣是 host 送來的事實:host 說哪些設定動了,面板看當下的存放庫有沒有覆寫它們,決定要不要導覽(ADR-0024)。
_Avoid_: 切換, 重新載入, reload, repo switch

**Loaded commit window**:
圖形當下向後端索取的 commit 筆數上限。它只會因為明確的請求而變大 —— 按下載入更多、或搜尋為了觸及匹配的 commit 而擴大 —— 只會整個彈回開場筆數而變小,不會停在中間值。縮回有兩條路:圖形頁尾那個唯一為此而設的重設入口,以及那些為了別的目的而做、順帶把視窗清掉的導覽。**分界是抵達的路,不是導覽的種類** —— 由面板自己呼叫的那些(換存放庫、換分支篩選、切換遠端分支顯示、從欄位標題選單改 commit 排序、從 Repository Settings 抽屜改載入範圍)清;由 host 改寫 repo state 後靠比對認出來的那些,以及 host 送來的 Repository Setting 預設值變更,不清。commit 排序兩條路都走得到,所以它從選單改會清、從面板外抵達不會清,這是同一個欄位的兩條路,不是矛盾。不清的理由也在路上而不在欄位上:那條路會為使用者沒動手的變更觸發(可分享的設定檔、第二個圖形面板),收掉他撐大的圖形是他無從歸因的損失 —— 預設值那一條使用者是動了手,但改的是每個沒覆寫的存放庫共用的值,不是對眼前這張圖形下的指令;而且「導覽,不縮」是這個泛化唯一安全的預設值 —— 反過來的話,以後每個被加進比較的欄位都自動繼承一個破壞性副作用(ADR-0024)。它跨面板重載保存,而面板每次重新變得可見就是一次重載,所以撐大的視窗會一路跟著使用者回來;正因如此,它一超過開場筆數,頁尾就顯示它當下的數值與一個把它縮回去的控制項,停在開場筆數時則什麼都不顯示。
_Avoid_: page, 分頁, commit 快取, maxCommits(那是實作名)

### Find 的位置與步進

Find 在畫面上有兩個讀數 —— 計數器與匹配列上的高亮 —— 卻只有一個位置。移動它可能當場完成,也可能要等:等一份新的 branch index、等使用者答覆確認、等一頁 commit 落地。以下三個詞把「Find 站在哪」「使用者要它去哪」「還在等的那一步」釘開。

**Find position**:
Find 當下指著的那一個匹配,身分是 commit hash;序號(計數器 `3/7` 裡的 3)只是它在匹配清單裡的讀法。計數器與高亮是**同一個** Find position 的兩種呈現,不可各自前進 —— 只動其中一個,兩個讀數就在說不同的事。目標那一列還沒載入時分兩種情形:不必確認的 step 當場記下位置,高亮暫時無處可畫,計數器先到 —— 那是同一個位置少了一種呈現,不是兩個位置;需要確認的 step 在使用者答應後只送出請求,計數器、高亮與捲動都隨那一頁一起抵達。匹配清單重建時(重繪、branch index 抵達)序號會位移,位置靠 hash 找回同一個 commit;只有那個 commit 不再匹配時,才依最近一次 Find step 的方向落到鄰近的匹配。程式裡 `findCurrent` 是序號,`FindPosition` 是 hash 加序號、能把 Find 放回原處的快照;`findSettledOn` 則是最近一次已處理過的 Find position 的 hash,只在 branch index 的回覆抵達時被拿來比對,分辨「這份回覆換了目標」與「同一份 branch index 的回覆又來了一次」,重繪時不靠它決定任何事 —— 它記的是 Find 指向哪裡,不是畫面捲到過哪裡。
_Avoid_: cursor, 游標, selected match, current match index

**Find step**:
使用者要求 Find 移到上一個或下一個匹配的一次**操作** —— 不是瀏覽,所以它會把目標捲進視野(ADR-0019)。一個 step 只有兩種結局:整個發生,或完全沒發生;不存在 step 記下了、卻沒有任何東西會來把它做完的半套。目標在 loaded commit window 之外時,step 要撐大視窗去拿那一頁(超過門檻先問使用者):它在請求送出的那一刻發生,而途中要前往的 commit 記在 `pendingFindTargetHash`,讓那一頁落地時的重建仍落在目標上,並把它捲進視野。請求送不出去(已有載入在飛)時,step 沒有發生,什麼都不記,而且要明講被拒絕(`dialogFindStepBusy`)。確認框立著時 step 也還沒發生;使用者答應之後它才發生 —— 除非這段時間裡有載入搶先開始,那時同樣明講(`dialogFindLoadBusy`)。`FindLoadOutcome` 回答的是 step **此刻**能不能記下自己:`move` 能,`hold` 不能。
_Avoid_: jump, 跳轉

**Pending Find navigation**:
落在「名字匹配的分支」上的 Find step,在新的 branch index 回來之前的樣子。分支可能在手上那份 index 抓取之後移動過,所以落點以回覆為準,不以按下的那一刻為準。在那之前它只是一個**願望**:Find position 不動、方向不記;回覆抵達時才找出那條分支現在的 commit,照 Find step 的規則決定發生或不發生,被拒絕(`hold`)就回到原本的 Find position。它雖然叫 navigation,卻**不是** Navigation:它不改變哪些 commit 該在畫面上,也不作廢在飛的載入。等待期間再按步進,從這個待決的目標起算,所以連按不會被吞掉。換搜尋、關閉 Find、或 branch index 作廢時,它被丟棄。程式裡是 `pendingFindNavigation`(型別 `PendingFindNavigation`)。
它與 `pendingFindTargetHash` 不可互換:這個等的是 branch index,step **尚未發生**;那個等的是一頁 commit,step **已經發生**,只是目標那一列還沒畫出來。
_Avoid_: pending step, queued step

### 忙碌指示

**Busy indicator**:
Refresh 按鈕上的轉動標示 —— 圖形留在畫面上、背後正在重新載入時,告訴使用者「有載入在進行」的那個標示。它亮著,當且僅當還有至少一個 busy claim 沒有放下;它不是一個「有人設了、還沒人取消」的旗標。不是每個載入都認領它:載入更多、捲動自動載入、以及頁尾的 loaded commit window 重設入口都不認領,它們用頁尾自己的標示;從欄位標題選單改 commit 排序也不認領。
_Avoid_: loading flag, spinner, refreshing state

**Busy claim**:
一次載入對 busy indicator 的認領。載入開始時舉起(`beginBusyLoad`),並在它可能結束的**每一條**路上恰好放下一次(`endBusyLoad`)—— 包括請求被丟棄、根本沒有載入發生的那些路,以及被導覽作廢的那些。`busyLoads` 是當下還沒放下的 claim 數,indicator 只隨最後一個熄滅。來源有四:分支與 commit 整套的重新載入(refresh,以及走同一條路的開機與導覽)、branch filter 變更後的重新載入、需要翻頁的 Find step,以及從 Repository Settings 抽屜改了一個要重載 commit 的設定(`applyRepoSettings`)。
它是計數而不是旗標,因為這些來源會重疊 —— 一次 refresh 的分支半段出去之後、commit 半段還不存在時,第二次 refresh 就能開始。用設定 / 取消,先結束的那個會替還在跑的那個宣告閒置。舉起而沒放下,按鈕就轉到面板關掉為止;放下兩次,就帶走了別人的 claim。
_Avoid_: busy flag, loading state, refreshing

### Commit Details View

圖形同一時間至多展開一個 commit,它的內容顯示在 Commit Details View 裡。這個 view 有兩種擺法;而「把它畫出來」與「把它打開」是兩件事 —— 每一次重繪都會重畫它,只有打開才會移動畫面。

**Commit Details View**:
展開一個 commit 時,顯示它的摘要與變更檔案清單的那塊區域;拿它與第二個 commit 比較時,改列出兩者之間的變更。縮寫 CDV,UI 上的名稱是「commit 詳情檢視」(zh-cn「commit 详情视图」)。同一時間至多一個;它展開的那個 commit 在程式裡是 `expandedCommit`。設定 key 沿用既有的 `detailsPanel.*`(`detailsPanel.position`、`detailsPanel.autoScroll` 等),key 不改,但行文一律稱 Commit Details View 或 CDV。
_Avoid_: details panel, commit details panel, 細節面板, 詳細資料面板

**Inline CDV**:
`detailsPanel.position` 為 `Inline`(預設值)時的 CDV —— 插在被展開那一列正下方的一列,是圖形表格的一部分、位於文件流中:它有多高,下面的 commit 就被往下推多少,高度由使用者拖曳。因為它在表格裡,整表重繪會連它一起換掉。
_Avoid_: expanded row, 展開列

**Docked CDV**:
`detailsPanel.position` 為 `Docked to Bottom` 時的 CDV —— 固定在視窗底部,不在圖形表格裡、也不在文件流中,所以不推動任何一列。圖形的列從它底下捲過,就像從 frozen header 底下捲過:被它蓋住的那一段不算看得見,方向鍵與 Page Up/Down 把列帶進視野時,視野的底邊是它的頂邊。整表重繪碰不到它,所以關閉它、或它展開的 commit 不再被載入時,都要另外把它拿掉。
_Avoid_: bottom panel, 底部面板

**CDV opening**:
CDV 變成**另一個** CDV 的那一刻 —— 從無到有、換了展開的 commit、或換了比較對象。CDV 的身分是「展開的 commit + 比較對象」(`cdvIdentity`),`cdvBroughtIntoView` 記著最近一次已經帶進視野的那個身分;身分與它不同就是開啟,相同就不是,不論中間重畫了幾次。關閉會清掉這份記憶,而展開 commit 的請求一律先關掉舊的 CDV,所以經由它抵達的都是開啟,即使展開的是同一個 commit。只有開啟會把 CDV 帶進視野(ADR-0019):`detailsPanel.autoScroll` 開著時置中,關著時只捲到剛好看得見 —— 關掉它不等於不捲。目前只有 inline CDV 會這樣捲;docked CDV 開啟時畫面不動。
_Avoid_: reopen, 重新顯示

**CDV rebind**:
重繪之後,把仍然開著的**同一個** CDV 接回新畫出來的那一列。整表重繪會換掉每一列,CDV 掛著的那一列也跟著換,所以每次重繪都要依 commit hash 找回展開的 commit 的新列,再重畫 CDV。rebind 不是 CDV opening:身分沒變,所以不捲動、不關閉;從手上的內容重畫時,檔案清單的焦點也回到原本那個檔案(見 row identity)。展開的 commit 不在新的列裡時,CDV 被關閉,不是 rebind。比較對象不在新的列裡時,CDV 退回只展開那個 commit —— 身分變了,所以那是一次開啟、會捲動,這是「重繪不移動任何東西」目前已知的缺口。
_Avoid_: reopen, refresh CDV, 重新開啟

### 跨重繪的身分

重繪(`renderTable`)把整張圖形表格從資料重新畫一次 —— 載入更多、soft refresh、Find、切換欄位都會觸發它。它不是使用者的操作,所以不得移動任何東西(ADR-0019)。要分辨「同一份內容重畫了一次」與「換成了新內容」,靠的是身分,不是 DOM 元素。

**Row identity**:
一列**代表什麼**,而不是它是哪一個 DOM 元素。重繪會換掉每一個列物件,所以要撐過重繪的東西 —— 首先是鍵盤焦點 —— 在重繪前記下持有它的那一列的身分,重繪後用身分在新的列裡找回同一列。commit 列的身分是 commit hash(`graphRowKey`);欄位表頭列與未提交變更列各只有一列,身分就是「那一列」;CDV 的檔案列是檔案路徑(`cdvFileKey`,rename 取新路徑),不用位置,因為 Tree 與 List 兩種版面排列不同,同一個檔案在兩邊的序號不一樣。身分只細到列:焦點在列內的 ref 標籤上時,重繪後回到那一列本身。找不到同一個身分時,圖形只把 tab stop 放到展開的 commit 那一列(沒有就是第一個 commit),不搶焦點;檔案清單則什麼都不做。CDV 自己的身分(見 CDV opening)與 Find position 以 hash 記位置,都是同一個想法。
_Avoid_: row index, 列號, 第幾列

### Rebase 搬走的 commit

「使用者圈出來的那一段」與「git 真的會重放的那些」不是同一組 commit,差別在 merge。這兩個詞把它們釘開,以及釘住差別漏出來的那個後果。

**Replay list**:
rebase 對話框列出的那組 commit —— **git 真的會重放的**那些,不是「範圍裡的」那些。沒有 `--rebase-merges` 的 rebase 從不重放 merge commit,所以 merge 不在清單裡,而它兩側的 commit 都在(菱形被壓成一條直線)。它是「哪些 commit 會被搬」的唯一真相來源:使用者逐筆勾選,剩下的勾選決定跑哪一個 git 指令(ADR-0023)。它讀的是已載入的 commit,所以範圍下界掉出 loaded commit window 時清單可能是短的 —— 那時它照顯示但不可勾,因為短的清單一旦可勾就會丟掉使用者沒被展示過的 commit。
_Avoid_: 範圍裡的 commit, commit range, 選取範圍, rebase 清單

**Stranded branch**:
rebase 之後仍指著**原本**那個 commit 的本地分支 —— 它底下那筆 commit 被複製了一份放到新基底上,標籤卻沒有跟著走,於是同一份改動在圖上出現兩次。git 只搬 tip 那一條分支,範圍裡其他 commit 上的本地分支一律留在原地;被壓平的 merge 讓這件事變成常態,因為側枝的標籤必定落在那種位置。對話框在**有 merge 被壓掉**時把它們逐一列名 —— 那正是使用者最不會預期它們的時候。
_Avoid_: duplicate branch, 沒搬到的分支, 重複分支
