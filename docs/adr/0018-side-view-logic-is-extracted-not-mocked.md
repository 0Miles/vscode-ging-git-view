---
status: accepted
---

# 側檢視的可測邏輯抽成 vscode-free 模組,轉接層不建 mock harness

分支側檢視的每一段有判斷的邏輯,一律抽成不 import `vscode` 的模組,在 backend 測試專案裡單元測試。`branchesView.ts` 這層轉接層**不**建 vscode mock harness:它剩下的接線 —— 把 TreeView 事件餵進去、把決策解讀回 VS Code API 呼叫 —— 由 code review 守。`branchFilterStore.ts` 同理。

## 為什麼未來的讀者會困惑

13 個 branch 模組裡有 11 個是 vscode-free,其中 10 個在 backend 測試專案裡有專屬單元測試(`branchTree`、`branchSelectionReconciler`、`branchActionTargets`、`branchCleanup`、`branchExempt`、`branchFacts`、`branchFilter`、`branchMerged`、`branchActivity`、`branchActionDelegate`;`branchCleanupService` 只在整合套件裡被建構,沒有專屬測試)。偏偏 611 行的 `branchesView.ts` 一支測試都沒有。看起來像沒補完的洞。

而且工具是現成的。backend 測試專案早就在測 import vscode 的模組:`webviewBridge.test.ts` 用空樁 `vi.mock("vscode", () => ({}))`(它只拿 vscode 當型別),`repoFileWatcher.test.ts` 更是手寫了一個**功能性**的樁 —— 假造 `workspace.createFileSystemWatcher`、把註冊進來的 handler 接住供測試觸發,形狀正是 `createTreeView` 要做的事。webview 專案另有一份 84 行的手寫替身。所以「做不到」從來不是理由,成本也不是主要理由。

更難的是,這條規則的代價已經現形過一次。[#42](https://github.com/0Miles/vscode-ging-git-view/issues/42) 的 bug 是抑制旗標的武裝條件量錯了集合:該問「branch selection 是否非空」,卻問了「TreeView 有沒有任何列被反白」。當時規則那端(`branchSelectionReconciler`)綠著,而判準那端**根本還沒抽出來** —— 過濾 leaf 的那段內嵌在 view 裡,零覆蓋。

## 考慮過但否決的方案

**用 `vi.mock("vscode", …)` 給 `branchesView.ts` 建 harness。**

樁的規模比先例大:`BranchItem` 是 `extends vscode.TreeItem`,樁必須提供真的 constructor;`createTreeView` 回傳的 fake 要能讓測試設定 `selection` 並觸發 `onDidChangeSelection`;再加上 `EventEmitter`、`commands.executeCommand`、`Uri.from`、`ThemeIcon`、`ThemeColor`、`registerFileDecorationProvider`、`showQuickPick`,以及 `TreeItemCollapsibleState` 與 `QuickPickItemKind` 兩個 enum。但這只是成本,不是否決理由。

否決理由是樁**抓得到什麼、抓不到什麼**的分界。抓得到的:傳錯集合(呼叫邊界上放個 spy 就看得見)、QuickPick 組裝、decoration URI 的旗標編碼、批次 target 解析、dispose 是否完整。抓不到的:一切取決於 VS Code 實際語意的東西 —— 而接線 bug 裡最要命的正是這一類。#42 的成因是 `clearSelection()` 只遞增 leaf 的選取世代號、folder id 走另一個世代號,所以只反白資料夾時「清除」不改變選取集、不發事件。樁只會照我們寫的演:我們若以為清除必然發出事件,樁就必然發出事件,綠燈只證明我們前後一致。

所以 #42 對這條論證是半個反例,要誠實記下來:**傳錯了什麼**樁抓得到,**為什麼會錯**才需要 VS Code 知識。這個否決不是「樁沒用」,而是樁的收益集中在抽取同樣能拿到的那一半,而抽取還附帶複利 —— 判準一旦有名字有測試,下一個問同樣問題的地方會拿到同一個答案。

**改用 `tests/extension/` 的真實 VS Code 環境。**

這條路能繞開上面的循環,但走不通:`TreeView.selection` 宣告為 `readonly selection: readonly T[]`,`reveal` 只能選單一元素,測試根本造不出多選狀態。這不是巧合 —— direct-write 路徑(多選搜尋繞過樹直接寫 filter)存在的原因就是這個 API 限制,而 #42 的 bug 就住在那條路徑上。

**把 `branchesView.ts` 一路拆到接線消失。**

誘人,但接線不會歸零:`createTreeView`、`onDidChangeSelection`、`reveal`、`registerFileDecorationProvider` 的呼叫本質上就得有人做。抽取的目標不是消滅接線,是讓剩下的每一行接線**明顯正確** —— 短到讀一遍就知道對不對。

## 後果

- **`branchesView.ts` 的錯誤只有 code review 攔得住。**因此往這個檔案加邏輯時,預設動作是先問「這段能不能抽出去」,而不是「怎麼測它」。
- **接線層的 bug 會以 #42 的形狀復發。**修這類 bug 時,回歸測試要釘的是抽出去的判準,不是接線本身;把判準抽出來、讓錯誤的呼叫難以寫出,才是修法。#42 最後就是這樣收的 —— `branchSelectionOf` 因此誕生,並促成 `CONTEXT.md` 的 **Branch selection** 條目補上「VS Code 回報的原始選取集不等於 branch selection」([#64](https://github.com/0Miles/vscode-ging-git-view/issues/64))。
- **這條規則會過期。**若 `branchesView.ts` 的接線密度高到 review 攔不住 —— 例如出現第二條 direct-write 路徑,或轉接層開始長出分支判斷 —— 這個決定值得重開。屆時要重估的是上面那條分界(樁抓不到的那一半有多大),不是成本。

## 補記(2026-10-30,#157)

**direct write 的範圍已經擴大到 `branches.showAll`;這不是上面那條到期條件說的「第二條 direct-write 路徑」,決定不變。**

正文把 direct write 寫成多選搜尋那一條路。[#43](https://github.com/0Miles/vscode-ging-git-view/issues/43) 之後,「Show All」(`branches.showAll`)也走同一條路:它寫的是空集合,做的卻是同一件事 —— 不經 tree selection 寫 filter、自己清掉樹的反白、吞掉清除送出的那個空選取事件。所以這個詞現在指的是這個形狀,不是哪一個手勢。定義見 `CONTEXT.md` 的 **Direct write**,以它為準。

成因也跟著放寬。正文說這條路存在,是因為 `reveal` 只能選單一元素;「Show All」缺的是另一半 —— TreeView 也沒有清除選取的 API,`clearSelection` 是替 leaf 換 id,讓 VS Code 自己丟掉選取。兩者是同一個限制:擴充功能設定不了樹的選取。

至於「後果」最後一條的到期條件:#43 之前,「Show All」其實**就是**第二條 direct-write 路徑 —— 它在 `extension.ts` 裡自己寫 filter store、自己呼叫 `clearSelection()`,沒有知會 reconciler,於是清除送出的空事件被讀成一次新的「顯示全部」,同一筆寫入又排了一次;只因 filter store 忽略相同的值,才沒有使用者看得見的後果。#43 的修法正是這篇要的那一種:沒有替接線建 harness,而是把整段步驟順序抽成 vscode-free 的 `createDirectFilterWriter`,由 backend 測試釘住;`branchesView.ts` 只綁定一次,兩個呼叫端各剩一行 `directWrite(repo, refs)`。所以那條條件該讀作「接線裡出現第二份自己的寫入順序」,不是「出現第二個呼叫端」。以現狀來說,它沒有觸發。
