---
status: accepted
---

# Fetch 預設 prune 分支,但永遠不 prune tag

`ging-git-view.fetch.prune` 的預設值是 **true**,`ging-git-view.fetch.pruneTags` 維持 **false**。所以開箱狀態下,擴充功能送出的每一次 fetch 都帶 `--prune`、都不帶 `--prune-tags`。

四條 fetch 路徑都各自即時讀 `config.fetchAndPrune()`,沒有人快取它,所以這個預設一翻,四條路徑同時生效:graph 控制列的 Fetch([messageHandler.ts](../../src/extension/messageHandler.ts))、`ging-git-view.fetch` 命令、單一 remote 的 fetch,以及 auto-fetch 定時器(後三者都在 [extension.ts](../../src/extension.ts))。

## 為什麼未來的讀者會困惑

一個「只是把 commit 畫出來」的擴充功能,預設卻會刪掉本地的東西,直覺上不對。而且 prune 刪掉 remote-tracking ref 是**不可逆**的 —— 這在決策時被提出並權衡過,不是沒想到。

站得住腳的理由有兩層。第一,代價其實很低:被刪掉的 ref 若在遠端還活著,下一次 fetch 就長回來;真正消失的那些,本來就已經不存在了。第二,不 prune 的代價反而更高 —— 現在主流的工作流是 PR 合併後由 host 自動刪除來源分支,不 prune 的話那些死掉的 tracking ref 會**永久**留在 `refs/remotes/<remote>/*` 底下被畫進 graph,而 graph 正是這個擴充功能的全部([#34](https://github.com/0Miles/vscode-ging-git-view/issues/34))。畫出一條早就不存在的分支,比誤刪一個重新 fetch 就回來的 ref 更糟。

要注意的是這只影響**沒設過**的人:已經在 git 設定 `fetch.prune = true` 的使用者,git 本來就會讀該設定,行為不變。

至於 tag 為什麼不比照辦理:刪掉一個本地 tag 沒有等價的「下次 fetch 就長回來」—— 遠端已經沒有它了,那個 tag 就真的沒了。破壞性不同,所以預設也不同。

## 考慮過但否決的方案

**維持預設 false,改在 graph 上把 stale 的 tracking ref 標出來並提供一鍵 prune。** 完全不動任何人的既有行為,而且把不可逆的動作留給使用者按。否決是因為它把一個 git 早就內建、一個旗標就解決的問題,換成擴充功能自己維護一套偵測 + 標記 + 動作;而使用者要的是那條線不要出現,不是多一個提醒它出現了的標記。

**維持預設 false,首次遇到 stale ref 時提示要不要開啟 prune。** 折衷,但它把一次性的設定決策變成一個會打斷人的彈窗,還得額外保存「已經問過了」的狀態。對一個正確答案幾乎總是「要」的問題,問了是噪音。

## 後果

- **既有使用者是靜默的行為變更。** 沒設過 `fetch.prune` 的人升級後,下一次 fetch 就會開始刪 stale 的 remote-tracking ref,而且沒有任何提示。這是刻意的。
- **`pruneTags` 會從惰性變成有效,所以有一次性的補救。** `--prune-tags` 的閘門是 `input.prune && input.pruneTags`([fetch.ts](../../src/backend/actions/fetch.ts)),而那是 git 自己的規則:實測 `git fetch --prune-tags` 不帶 `--prune` 時退出碼 0、無警告、本地 tag 原封不動。所以在 `prune` 還是 false 的年代,單獨把 `fetch.pruneTags` 設成 true 是**沒有作用**的,而且完全沒有回饋 —— 使用者很可能以為它一直在運作。

  這次翻轉會打開那道閘門,他們自己什麼都沒改,下一次 fetch 就開始刪本地 tag,而刪掉的 tag 沒有「下次 fetch 就長回來」。因此 [pruneTagsMigration.ts](../../src/extension/pruneTagsMigration.ts) 在翻轉後的第一次啟動,把這批人的 `fetch.pruneTags` 寫回 false 並告知一次。判準是「`fetch.prune` 沒有任何明確值」—— 自己設過 prune 的人(不論 true 或 false)是在 pruneTags 就在旁邊的情況下做的決定,不動他們。

  它即使沒清到任何東西也會標記自己跑過,否則使用者日後**刻意**開啟 pruneTags 時會被第二輪靜默關掉。這段是過渡碼:等到不再有人跨過這次翻轉升級,整個模組連同旗標都可以刪掉。

- **`prune: true, pruneTags: false` 現在是幾乎每一次 fetch 的組合。** [fetch.test.ts](../../tests/backend/actions/fetch/fetch.test.ts) 因此明確釘住這個組合會掃掉分支、留下 tag;`--prune-tags` 若哪天脫離閘門,那個測試會紅。
