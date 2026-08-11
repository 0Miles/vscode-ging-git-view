---
status: accepted
---

# 圖形的右鍵選單自己畫,而且圖示用 Octicons 而不是 Codicons

圖形裡的六個右鍵選單(欄位表頭、commit、未提交變更、參照、commit 訊息連結、CDV 檔案)全部由 [main.ts](../../src/webview/main.ts) 的 `showContextMenu` 在 webview 內自行渲染,樣式在 [main.css](../../media/main.css) 逐條對齊 VS Code 的 `.monaco-menu`。選單項目的圖示是內嵌 SVG,取自 **Octicons v19**(MIT),不是 VS Code 自己的 Codicons。

## 為什麼未來的讀者會困惑

有兩個「明明有現成的為什麼不用」:

**一、VS Code 有 `webview/context` 貢獻點。** 它是穩定 API,`data-vscode-context` 加 `when` clause 就能讓 webview 彈出**真正的**原生選單,樣式永遠跟著 VS Code 走,一行 CSS 都不用維護。第一直覺一定是「把 `showContextMenu` 整個刪掉換成它」。

**二、這是 VS Code 擴充功能,圖示的自然選擇是 Codicons。** 側檢視就在用(`new vscode.ThemeIcon("git-branch")`,見 [branchesView.ts](../../src/extension/branchesView.ts)),用 GitHub 的圖示集看起來像是搞錯了對象。

兩個都不是疏忽。

## 考慮過但否決的方案

**改用 `webview/context` 原生選單。** 否決的是兩件事,任一件單獨就足夠:

- **原生選單畫不了圖示。** `contributes.menus` 的項目只有 `command` / `when` / `group` / `alt` / `submenu`;VS Code 的下拉選單從來不渲染 icon,要求這件事的 [microsoft/vscode#53868](https://github.com/microsoft/vscode/issues/53868) 至今未實作。「用原生選單」與「選單項目上有圖示」在字面上互斥。
- **這些選單的標題與可見性是執行期算出來的。** 欄位顯示與 commit 排序帶打勾狀態(而 `contributes.menus` 沒有 `toggled` 屬性),Drop 只在 `dropCommitPossible` 的拓撲檢查過關時出現,約 40 個 `contextMenuActionsVisibility` 開關各自控制一項,再加上 `remotes.length > 0`、`splitRemoteRef()`、`firstIssueUrl()`。全部搬成 context key 表示新增約 50 個 command 進 `package.json`、乘上四份 nls 檔,換來的仍是一個沒有打勾也沒有圖示的選單。

**用 Codicons 當圖示來源。** 否決原因有二。授權上它是 CC-BY-4.0(字型與程式碼才是 MIT),而這個專案偏好 MIT;交付形式上,VS Code **不會**把 codicon 字型注入 webview(`getWebviewThemeData` 只注入字型變數、顏色 token 與 size token),所以得自己 bundle `codicon.ttf` 149 KB 加 `codicon.css` 39 KB,並在 CSP 開一條 `font-src`。Octicons 是 MIT、16×16、而且 git 領域的覆蓋率沒有別套比得上——它就是 GitHub 畫的。決定性的是這個 repo **本來就是**用內嵌 SVG(`svgIcons`),而且本來就是 Octicons,只是 v2/v3 世代;沿用等於不引入第二套機制。

**維持 Octicons v2/v3 不升級。** 舊世代的 viewBox 不統一(`0 0 10 16`、`0 0 12 16`、`0 0 14 16`),放進選單那條固定寬度的圖示欄會寬窄不一。既然要進選單就得統一到 16×16,而只升級一半會讓 CDV 檔案列的 hover 按鈕和緊貼著它彈出的選單同時出現兩個世代的同一個圖示。

**Fluent UI System Icons(MIT、微軟)。** 視覺語言最接近 VS Code,但完全沒有 git 相關圖示,對一個 git graph 是致命傷。

## 後果

- **樣式要人工追。** `.monaco-menu` 的數值是從 VS Code bundle 抄出來的(擷取時為 1.131.0),VS Code 改版時不會自動跟上。`--vscode-cornerRadius-*` 與 `--vscode-strokeThickness` 這兩個 design token 要 VS Code ~1.13x 才會注入 webview,而 `engines.vscode` 是 `^1.98.0`,所以每一處都必須帶 fallback。`--vscode-shadow-lg` 更是完全不會注入(它定義在 `.monaco-workbench` 上),只能寫死——所幸它在 VS Code 裡本來就是與主題無關的定值。
- **鍵盤導覽也得自己做,選單內外都是。** 選單**內部**的方向鍵、Home/End、Enter、Tab、`role=menu`/`menuitem`/`menuitemcheckbox` 都在 `showContextMenu` 附近手寫。選單**外部**同樣要自己來:commit 列、參照標籤、欄位表頭與 CDV 檔案列各自帶 roving tabindex,`Shift+F10` 與 Context Menu 鍵在焦點元素上派送 `MENU_KEY_EVENT`,由 `addContextMenuListener` 註冊的同一批 handler 接住 —— 所以每個選單都必須經由它掛載,只掛 `contextmenu` 的選單開不了鍵盤。沒有指標座標時,`showContextMenu` 改以來源元素的 bounding box 定位。代價是上下鍵從「捲動畫面」改成「在列之間移動」,見 [ADR-0014](0014-arrow-keys-move-between-rows-not-the-viewport.md)。
- **cherry-pick 與 rebase 是手繪的。** Octicons 和 Codicons 都沒有這兩個圖示,而它們是核心 git 操作。手繪的兩個沿用 Octicons 的 git 語彙(垂直線是分支、實心圓是 commit),所以看起來像那一家的成員。新增同類圖示時請照這個語彙走,不要混入別套的筆法。
- **stash 的 apply 與 pop 沒有圖示。** 兩者的差別只在「是否保留 stash」,那不是圖形性質;給它們同一個圖示會誤導,而誤導比留白更糟。這是 `icon?` 刻意可省的原因,不是漏標。
- **[ADR-0005](0005-menu-labels-lead-with-the-action.md) 仍然有效。** 那條規則(中文選單文案第一個 token 必須是動作)是為了讓眼睛沿左邊界掃視。圖示加在文字**前面**,看似取代了那個錨點——但沒有圖示的項目(檢查冗餘、開啟原始檔控制檢視、stash apply/pop)仍然只能靠文字掃。而且有無圖示的項目文字都從同一個 x 開始,左邊界照樣對齊。不要因為「現在有圖示了」就把文案改回自然語序。
