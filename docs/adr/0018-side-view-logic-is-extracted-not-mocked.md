---
status: accepted
---

# 側檢視的可測邏輯抽成 vscode-free 模組,轉接層不建 mock harness

分支側檢視的每一段有判斷的邏輯,一律抽成不 import `vscode` 的模組,在 backend 測試專案裡單元測試。`branchesView.ts` 這層轉接層**不**建 vscode mock harness:它剩下的接線 —— 把 TreeView 事件餵進去、把決策解讀回 VS Code API 呼叫 —— 由 code review 守。`branchFilterStore.ts` 同理。

## 為什麼未來的讀者會困惑

13 個 branch 模組裡有 11 個是 vscode-free,其中 10 個在 backend 測試專案裡有專屬單元測試(`branchTree`、`branchSelectionReconciler`、`branchActionTargets`、`branchCleanup`、`branchExempt`、`branchFacts`、`branchFilter`、`branchMerged`、`branchActivity`、`branchActionDelegate`;`branchCleanupService` 走 `tests/extension/` 的整合套件)。偏偏 611 行的 `branchesView.ts` 一支測試都沒有。看起來像沒補完的洞。

而且不是做不到。backend 測試專案早就在測 import vscode 的模組,手法是逐檔 `vi.mock("vscode", …)`,`webviewBridge.test.ts` 就是現成先例,共用設定一行都不用動。「有先例、有工具、就是沒做」是個很難不去補的形狀。

更難的是,這個策略的代價已經現形過一次。[#42](https://github.com/0Miles/vscode-ging-git-view/issues/42) 的 bug 是抑制旗標的武裝條件量錯了集合:該問「branch selection 是否非空」,卻問了「TreeView 有沒有任何列被反白」。判準與規則兩端當時都有測試,兩端都是綠的 —— 錯的是中間那一行接線,而接線正是這條規則放生的地方。

## 考慮過但否決的方案

**用 `vi.mock("vscode", …)` 給 `branchesView.ts` 建 harness。**
樁的規模是第一個問題:`BranchItem` 是 `extends vscode.TreeItem`,樁必須提供真的 constructor;`createTreeView` 回傳的 fake 要能讓測試設定 `selection` 並觸發 `onDidChangeSelection`;再加上 `EventEmitter`、`Uri.from`、`ThemeIcon`、`ThemeColor`、`registerFileDecorationProvider`、`showQuickPick` 與三個 enum。`webviewBridge` 用空樁就夠是因為它只拿 vscode 當型別,這裡不是。

但規模只是成本,真正的否決理由是**這種測試證明不了想證明的事**。這麼大的樁測的不是 `branchesView.ts`,是「我們對 VS Code 行為的想像」。而接線層的 bug 恰恰長在想像與真實的落差上:#42 的成因是 `clearSelection()` 只 re-key leaf 而不動 folder,這件事沒有任何樁會主動告訴我們 —— 樁只會照我們寫的演。用它去釘接線,綠燈的保證強度等於我們當初理解的正確性,而那正是待驗的東西。

**改用 `tests/extension/` 的真實 VS Code 環境。**
這條路能繞開上一條的循環,但走不通:`TreeView.selection` 宣告為 `readonly selection: readonly T[]`,`reveal` 只能選單一元素,測試根本造不出多選狀態。這不是巧合 —— direct-write 路徑(多選搜尋繞過樹直接寫 filter)存在的原因就是這個 API 限制,而 #42 的 bug 就住在那條路徑上。能測的只剩 mock,於是又回到上一條。

**把 `branchesView.ts` 一路拆到接線消失。**
誘人,但接線不會歸零:`createTreeView`、`onDidChangeSelection`、`reveal`、`registerFileDecorationProvider` 的呼叫本質上就得有人做。抽取的目標不是消滅接線,是讓剩下的每一行接線**明顯正確** —— 短到讀一遍就知道對不對。

## 後果

- **`branchesView.ts` 的錯誤只有 code review 攔得住。**因此往這個檔案加邏輯時,預設動作是先問「這段能不能抽出去」,而不是「怎麼測它」。
- **接線層的 bug 會以 #42 的形狀復發:兩端全綠、行為仍錯。**修這類 bug 時,回歸測試要釘的是抽出去的判準,不是接線本身;把判準抽出來、讓錯誤的呼叫難以寫出,才是修法。#42 最後就是這樣收的 —— `branchSelectionOf` 因此誕生,並帶著「原始選取集不等於 branch selection」寫進 `CONTEXT.md`。
- **抽取的收益是複利的。**判準一旦有名字有測試,下一個需要問同一個問題的地方會拿到同一個答案;mock harness 的收益則停在被測的那一個檔案。
- **這條規則會過期。**若 `branchesView.ts` 的接線密度高到 review 攔不住 —— 例如出現第二條 direct-write 路徑,或轉接層開始長出分支判斷 —— 這個決定值得重開。屆時要重估的是上面第一條否決理由(樁的循環論證),不是成本。
