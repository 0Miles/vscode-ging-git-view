---
status: accepted
---

# 從存放庫清單重新開啟圖形,靠的是列上的明確按鈕,不是點擊列本身

VS Code 的 extension host 在 `$setSelectedSourceControl` 對**連續相同**的 source control handle 直接短路,因此重複點擊已聚焦的存放庫列時,`Repository.ui.onDidChange` 不會 fire,任何擴充功能都收不到訊號 —— 我們無法讓「再點一次目前存放庫」重新開啟圖形。取而代之,我們在 `scm/repository` 掛一顆 inline 按鈕,並且**只顯示在 focused repository 那一列**。

## 為什麼未來的讀者會困惑

程式碼裡有一整套 context key 同步機制([extension.ts](../../src/extension.ts) 的 `syncFocusedRepoContext`),外加 [scmRepoTracker.ts](../../src/extension/scmRepoTracker.ts) 多吐一份 uri 字串,只為了讓一顆按鈕出現在一列上。第一直覺會是「把 `recomputeSelection` 的去重拿掉不就好了」。**那沒有用** —— 我們自己的去重只是第二道閘門,事件在跨進 extension host 那一刻就已經被吃掉了。

證據(以 VS Code 1.10x 的 bundle 為準,未來版本請重新確認):

- `out/vs/workbench/api/node/extensionHostProcess.js` — `$setSelectedSourceControl(t){ return this._selectedSourceControlHandle === t || (…), Promise.resolve(void 0) }`
- `out/vs/workbench/workbench.desktop.main.js` — `SCMViewService.focus()` 本身**沒有**去重,每次點擊都 fire `onDidFocusRepository`;訊號是在 extension host 端才被擋掉的
- `extensions/git/dist/main.js` — `this.ui = new …(this.#e.sourceControl)`,所以 `Repository.ui.selected` 就是 `SourceControl.selected`

## 考慮過但否決的方案

**自製一個存放庫側邊欄。** 自製 TreeView 的 `TreeItem.command` 每次點擊都會執行(list widget 的 `onViewPointer` 無條件 `_onPointer.fire`),確實能做到「重複點擊有反應」。否決原因是**同步只能單向**:沒有任何 public 或 proposed API 能讓擴充功能指定 VS Code 的 focused / active repository(唯一相關的 `scm.setActiveProvider` 不收參數,只會彈 quick pick)。結果會是兩份存放庫清單、兩套高亮,而且我們那份永遠無法帶動原生那份。

**按鈕放在每一列。** 實作成本更低(零 TS 改動),但在非 focused 的列上與「點擊列」完全等效,是純冗餘;而 SCM 存放庫列的 inline action 沒有 hover 閘門,會常駐可見。只放在 focused 列,剛好補在唯一缺口上。

## 後果

- context key 的發布**不能**受 `ging-git-view.followSourceControlSelection` 影響。那個設定只決定要不要自動開啟圖形;關掉之後,這顆按鈕正是使用者僅剩的一鍵入口。
- 必須同時掛在 `onDidChangeRepos` 上補一次,因為 tracker 刻意不為啟動時的初始選取 fire `onDidChangeSelection`。少了這條,剛開 VS Code 時 focused 那列不會有按鈕。
- 非 focused 的列沒有按鈕,右鍵選單(`scm/sourceControl`)因此成為它們唯一的一鍵入口,不可移除。
