---
status: accepted
---

# BranchFacts 快取的是 git 讀取,不是分類結果

分支的分類事實(merged / inactive / hidable)收攏到單一模組 `BranchFacts`,分支側檢視與圖形的 `loadBranches` 回應共用它。它內部**只**快取那一次 git 讀取 —— `branches`、`head`、`defaultBranch`、merged refs、dates —— 分類與豁免則在每次呼叫時,從當下的 branch filter、config 與時間重算。快取由 `mutatesRepo` 的 mutation 路徑主動失效,file watcher 只當補網,另加一秒的 coalescing TTL。

## 為什麼未來的讀者會困惑

兩處看起來都像「優化只做了一半」,而兩處都是刻意的。

**「hidable 為什麼不一起快取?」**
分類是對約一百個字串做集合運算與 glob,微秒級,快取它省不到東西;但要快取它,就得買進三條失效邊:branch filter 每次點選就變(debounce 200ms)、`alwaysShow` 與 threshold 隨 config 變、而 inactive 還相依於**現在幾點**。最後那條沒有任何事件可以掛 —— 一個分支跨過門檻變成 inactive 時,檔案系統完全沒動。也就是說,快取 hidable 之後,它會用一種偵測不到的方式過期。快取包住昂貴且慢變的那半(一次讀取要 spawn 五個以上的 git 子行程),分類留在外面現算,兩邊各自維持在自己該有的新鮮度。

**「失效為什麼不掛 file watcher?」**
因為 file watcher 在分支變更的那一刻是**刻意聾的**。`mutatesRepo: true` 的 handler 執行前呼叫 `repoFileWatcher.mute()`、執行後 `unmute()`,而 `unmute()` 會設一段 1500ms 的靜音窗,把這次操作自己的 fs 事件**丟棄**(不是延後)—— 那是為了不讓自己的 side effect 彈回來變成多餘的 refresh。而 ADR-0010 把側檢視的分支動作也委派給 webview 執行,所以**每一次**分支變更都走這條被靜音的路。把失效掛在 file watcher 上,等於在唯一需要它的時刻讓它沉默:刪掉一個分支之後,下一次 `loadBranches` 會拿到還有那個分支的 snapshot —— 把一個顯示延遲升級成資料錯誤。`mutatesRepo` 反而是 exhaustive 的:它是必填旗標,型別強迫每個 handler 表態。

## 考慮過但否決的方案

**整包快取(含 hidable),filter / config / 時間都接上失效。**
否決理由如上:買進的三條失效邊裡有一條本質上接不起來,而省下的是微秒級的運算。

**完全不快取,兩面各自呼叫同一個模組。**
一致性同樣達成(單一模組就足夠),而且沒有任何過期風險,git 讀取次數與改動前相同。否決是因為 `mutatesRepo` 這個 seam 已經現成且受型別強制,邊際風險低;而一秒 TTL 能把同一個 tick 內兩面的重複讀取從約九個子行程併成約五個。

## 後果

- `facts(repo)` 帶有寫入 side effect:它會 resolve 並 seed 該 repo 的 branch filter。seeding 需要 `branches` 與 `head`,而 BranchFacts 是唯一持有 snapshot 的地方 —— 拆出去就得把單一入口攤成「讀 snapshot → 外面 seed → 回來算豁免」三步,反而把要收攏的東西又攤開。
- 側檢視因此開始受 `showSpecificBranches` 影響,不必等圖形開過一次。同理,關閉 show remote 時、filter 中遠端 ref 被 prune 掉(且不可逆)也會提前到側檢視這條路發生。
- snapshot 一律含 dates,圖形的 `loadBranches` 因此多一次 `for-each-ref`,即使它不消費 `inactive`。單獨看是多付,合起來(TTL 命中時兩面共用)是少付。
- `hard: true` 繞過 TTL,所以使用者按下的 Refresh 永遠是一次真正的讀取。
- 兩個 hide toggle(`showInactive` / `showMerged`)**不**進 BranchFacts。BranchFacts 只回答「哪些**可以**被藏」;藏不藏是側檢視的呈現決定,而圖形不藏任何東西。
- `showRemoteBranches` 由 `resolveShowRemote(repo)` 單一決定,不再由 webview 回送。它是 extension 狀態的單向回音,永遠只會比較舊,留著就是一個雙來源。
