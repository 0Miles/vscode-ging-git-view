---
status: accepted
---

# 側檢視分支動作由共用 catalogue 單點宣告

側檢視委派到圖形的分支動作,原本是一條沒有主人的 4-hop 管線:host 註冊端、host 委派端、wire 契約、webview dispatcher 各持有一部分規則,新增一個 action 要動 ≥5 個檔案,head guard 在 webview 被重抄了一份,dispatcher 對未列的 `(action, isRemote)` 組合靜默 no-op。我們決定把規則收進**一份兩邊共讀的 action catalogue**(`src/backend/utils/refActionCatalogue.ts`),每個 action 宣告五件事實:`refKinds`(收本地/遠端/皆可)、`headGuard`(不作用於 checked-out 分支)、`batch`(可否批次)、`needsRemotes`(需要至少一個 remote)、`runsIn`(在圖形或 host 執行)。host 與 webview 各留一層薄殼讀它;「deep module」指的是這份 catalogue 加上它定義的契約,不是某個單一物件 —— 管線橫跨兩個行程,單一物件本來就不可能。

## 為什麼未來的讀者會困惑

- **command 註冊是一個迴圈,不是清單。** `ging-git-view.branches.*` 的 18 條 command(14 條單一 + 4 條 `<action>Selected`)由遍歷 catalogue 產生(`batch: true` 者加註冊 `<action>Selected`,`runsIn: "host"` 者接 host-handler 表)。grep command ID 只會命中 `package.json` —— 這是刻意的:手寫清單「漏一條」正是要消滅的那類靜默失配,catalogue 有就必然註冊。
- **head guard 在 host,不在 webview。** 直覺上防線該設在執行端,但 guard 設在 webview 意味著 host 先把圖形面板叫到前景、然後 webview 靜默丟棄 —— 使用者看到面板無故彈出。host 的 tree item 本來就帶 `isCurrent`,在 `openGraphView` 之前提早返回,批次的 checkedOut 扣除也本來就在 host,單一與批次的 guard 從此站在同一邊、讀同一份欄位。擋下時維持靜默,與選單語意一致(選單本不該提供這些項目)。
- **錯誤策略是「開發期最早、最大聲」,沒有第二道 runtime 防線。** 不合法組合只有一種來源 —— 我們自己把選單接錯線 —— 所以 host 在送出前查 catalogue、不符就 throw;webview 的 action→handler 表宣告成 `Record<RefAction, …>`,漏列直接編譯不過。host 與 webview 同一個 bundle 出貨,不存在版本歪斜,webview 端的 runtime 再驗證防的是不會發生的事。
- **wire 上只有 canonical ref,沒有 `isRemote`。** `remotes/` 前綴就是「遠端」這件事實(CONTEXT.md「Ref 的兩種形」),布林與前綴是同一事實的兩份拷貝,必然分岔。單一動作訊息因此從 display ref + `isRemote` 改為 canonical ref,display ref 只在呈現時套用 —— 批次訊息一直如此,單一動作才是被矯正的例外。

## 考慮過但否決的方案

- **delegate 只做 host 半邊,webview 維持現狀。** 修不到重抄的 guard 和靜默 no-op 的 dispatcher —— issue 點名的病灶有一半在 webview,只做半題。
- **兩邊各自一個完整 delegate,靠 convention 對齊。** 這就是現況病灶的成因。
- **單一與批次併成同一種 wire 訊息。** 格式統一後兩種訊息確實長得像,但 Batch action 在領域上是獨立概念(能不能批次由 git 語意決定),`DelegatedBatchAction ⊂ RefAction` 這個子集關係用兩種型別表達最誠實;併掉之後「`rename` 帶 3 個 targets」型別上合法、只能靠 runtime 擋,且「選 2 條被扣到剩 1 條」須走批次流程(要顯示 skipped),用 `targets.length` 判斷流程會走錯。兩種訊息共用 envelope(repo、seq)與同一條 pending/dedupe 佇列。
- **catalogue 併進 `types.ts`。** `types.ts` 是純型別的 wire 契約,塞 runtime 資料會改變它的性質;catalogue 另立一檔,`RefAction` / `BatchAction` 等型別反過來由它的 key 推導。

## 後果

- 新增一個 action 只碰 3 個檔案:catalogue 一筆、webview 對應表一格(編譯器逼你補)、`package.json` 選單宣告(VS Code manifest 是靜態的,躲不掉)。
- 批次的 skip 規則不另設欄位,由推導而來:`skipped: checkedOut` ⇔ `headGuard`,`skipped: remote` ⇔ `refKinds: "local"`。已驗證三個批次動作皆成立(delete、fastForward 有 headGuard;push 沒有,也確實不跳過 checked-out)。
- `copyName` 不再是 `extension.ts` 裡的手寫特例,而是 catalogue 中 `runsIn: "host"` 的一筆(分流理由見 ADR-0009)。
- host 半邊第一次有 test surface:`createBranchActionDelegate` factory 依賴全數注入,seq 單調性、雙路送達與 flush、guard 提早返回、refKinds throw、格式正規化、copyName host 路徑、批次全滅訊息,皆可離線測。
- **`flushPendingRefAction` 仍是 caller 要接的線。** 「caller 只剩 `run` / `runBatch`」有一個刻意的例外:selectRepo 事件只有 extension.ts 的 message handler 聽得到,而 delegate 保持 vscode-free,所以「webview (re)load 時 flush」由 caller 在 `onSelectRepo` 裡呼叫 `flushPendingRefAction(repo)` 接上。契約的內容(何者該 flush、repo 不符不丟棄)在 delegate 裡並有測試;caller 承擔的只剩「把事件接到這個方法」一行。
- **單選 remote ref 的 `delete` 從靜默 no-op 變成可執行**(依前綴路由到 remote 刪除流程)。這是 `refKinds: "both"` 的直接後果,不是意外:選單對 remote 提供的措辭是 `deleteRemote`,所以這條路徑觸發不到;但「刪除」作為動作對兩種 ref 都成立,補完表沒有留 no-op 格。若未來想禁止,改 catalogue 為 `"local"` 並給批次 delete 另立欄位 —— 代價是 skip 推導失去單一出處。
- **`needsRemotes` 是唯一留在 webview 的靜默守門,刻意不走「顯式錯誤」策略。** throw 針對的是接錯線的程式錯誤;「repo 沒有 remote」是 runtime 的 git 狀態,只有 webview 知道(remotes 清單住在它那側),而且與圖內選單一致 —— 選單在無 remote 時根本不顯示這些項目,靜默正是選單語意。
