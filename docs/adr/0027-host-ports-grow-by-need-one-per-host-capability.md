---
status: accepted
---

# host ports 依需要長出來、按宿主能力分組,只放 dispatch 今天會呼叫的方法

圖形的 message dispatch(`registerMessageHandlers`)與 webview bridge 已經搬進 `packages/core`,不 import `vscode`。它向宿主(`CONTEXT.md` 的 **Host**:VS Code,之後還有桌面版)要的東西,全部透過 [ports.ts](../../packages/core/src/host/ports.ts) 裡的 port。截至 #295 共 9 個 —— `HostConfig`、`HostStorage`、`Prompts`、`Opener`、`Clipboard`、`Watcher`、`L10n`、`RepoSource`、`HostLogger` —— 其中 `HostStorage` 餵的是 core 的 `ExtensionState`(見下),其餘包成 `HostPorts` 交給 dispatch。

切法有三條規則:**依需要長出來**(先有呼叫端,才有方法)、**按宿主能力分組**(一個 port 是宿主的一種能力,不是一個方法,也不是整個宿主)、**只放 dispatch 與它旁邊的 core 服務今天真的會呼叫的方法**。port 是結構式的 interface,形狀比照 #294 的 `AvatarConfig` / `AvatarStore`,所以宿主常常能直接交出現成的物件:VS Code 這邊的 `HostConfig` 就是既有的 `Config`,`RepoSource` 就是 `RepoManager`。型別一律宿主中立 —— 路徑是字串不是 URI,被取消的詢問回答 `undefined`。VS Code 的實作在 [hostPorts.ts](../../apps/vscode/src/hostPorts.ts),每個方法只轉呼叫一次 VS Code API。

## 為什麼未來的讀者會困惑

- **`Prompts` 沒有 quick pick,也沒有 confirm,但 #295 的票面列了。** 不是漏做。dispatch 沒有任何地方呼叫它們 —— 圖形要問使用者的事,用的是 webview 自己的對話框 —— 所以照「先有呼叫端」的規則,它們不存在。今天 `Prompts` 有的是通知三種(`showInformation`、`showWarning`、`showError`)、存檔位置,以及 askpass 用的 `input`。它們真正會長出來的地方是 [#339](https://github.com/0Miles/vscode-ging-git-view/issues/339):把 `extension.ts` 命令 handler 裡的 git 操作搬進 core 時,那些 handler 的 `showQuickPick` 與確認框才會第一次需要宿主中立的版本,屆時照著那些呼叫端的形狀加。
- **`showAllBranches`、`configurePullRequestProvider`、`openScmView` 不是 port,是 `MessageHandlerDeps` 的 hook。** 它們跳回的是擴充功能自己的 VS Code 介面:側檢視標題列的 Show All 命令(ADR-0018 的 direct write)、管理 pull request provider 的 QuickPick 命令(ADR-0021)、VS Code 的原始檔控制檢視。這些不是「宿主的能力」—— 剪貼簿每個宿主都有,而「側檢視的 Show All」是 VS Code 版側檢視自己的功能,桌面版的側檢視要在 webview 裡重做,到時它長什麼樣還沒定。所以它們留在 hook,跟 `onSelectRepo`、`onDelegatedRan` 放在一起,一個請求對應一個函式。
- **current repository 的保存走 `HostStorage`,沒有 `setLastActiveRepo` 這個 port。** `ExtensionState` 整個搬進 core,改成架在 `HostStorage` 上:兩層 key-value(`workspace`、`global`)加上全域儲存的資料夾。讀的規則見 `CONTEXT.md` 的 **Current repository**。寫的規則 —— 既不是 known repository、路徑也不可用的值,記成「沒有選取」而不是照存 —— 在 `ExtensionState.setLastActiveRepo` 裡,理由只寫在它的註解中。若 port 開在 `setLastActiveRepo` 這一層,第二個宿主就得把寫的規則重寫一遍,讀的時候也得自己照規則解析;開在 key-value 這一層,兩邊的規則都留在 core,宿主只要交出最笨的儲存。
- **`RepoSource.dropRepo` 是「移除並廣播」一個動作,沒有單獨的 `removeRepo`。** 原本是 `removeRepo` 加 `sendRepos` 兩步,呼叫端可以只做前一步,讓顯示這份集合的地方留著已經不存在的存放庫。port 上只有合成後的這一個方法,所以只拿得到 port 的 core 寫不出漏掉廣播的移除。這個保證只到 port 為止:VS Code 的 `RepoManager` 仍公開分開的 `removeRepo` / `sendRepos`,app 內部的呼叫端照樣可能只做一半。`checkReposExist` 同理:只要丟掉了任何一個存放庫,它自己廣播。
- **「per-repo 覆寫,沒有就用全域預設」在 core 算,不在宿主算。** `HostConfig` 只交出全域預設(`showRemoteBranches()`、`repoSettingDefaults()`),dispatch 用 core 的 `resolveShowRemoteBranches` / `resolveRepoScope` 自己算。這條規則原本是宿主那邊的一個 hook,也就是每個宿主各寫一份;移進 core 之後只剩一份。
- **`Opener` 的參數形狀沒有統一。** 參數沿用各 message payload 的原形(路徑字串、`DiffSide`、`CommitDiffRequest` 並存),沒有為了整齊而轉換;待桌面版實作 `Opener` 時再看是否統一。

## 考慮過但否決的方案

- **一個方法一個 port。** 每個 port 都會剛好合身,但宿主拿到的是三十幾個 interface,而它提供能力的單位不是方法:Electron 的對話框、shell、剪貼簿各是一個模組,VS Code 的 `window`、`env`、`commands` 也是。按能力分組,一個 port 對應宿主的一處實作,測試的 fake 也是一個能力一個。
- **一個「宿主的一切」interface。** 最省事,但任何一個 handler 都看不出它用到宿主的哪些能力,fake 必須把整個宿主樁起來,而 port 的邊界 —— 什麼是宿主的事、什麼是 core 的事 —— 會隨著每一次「順手加一個方法」慢慢糊掉。
- **照 VS Code API 或照票面的清單,先把 ports 設計完整。** 會長出沒有呼叫端的方法,例子見上面的 `Prompts`。沒有呼叫端的方法沒有測試,形狀是猜的,而桌面版卻得照著實作它。
- **dispatch 留在 app,測試用 `vi.mock("vscode", …)` 補。** 理由同 ADR-0018:樁只會照我們寫的演。更根本的是,這次搬移的目的不是可測性,而是讓第二個宿主拿到同一份 dispatch;只要它還 import `vscode`,桌面版就只能重寫一份。dispatch 現在用 [fakeHost.ts](../../packages/core/tests/fakeHost.ts) 的假 ports 加上真的 bridge 測試。

## 後果

- **dispatch 需要新的宿主能力時,加在對應的 port 上,並同時補 VS Code 實作與 `fakeHost`。** 先有呼叫端;找不到對應的 port、而且那件事每個宿主都會有時,才開新的 port。只有 VS Code 版才有的介面走 hook,見上。
- **port 的註解就是契約,桌面版要照著實作。** 例如 `Prompts.input` 必須在焦點移開後仍然留著(askpass 讓 git 卡在它上面等),`Watcher.mute` 期間的變更不得觸發重新整理(ADR-0013)。
- **還有宿主相依的 git 操作不在 core。** `extension.ts` 的命令 handler 仍直接跑 git(fetch、remote 管理、reflog、`createBranch`、`resetToCommit` 等),blame 的查詢也還在 app。這些由 #339 承接。側檢視(TreeView)與命令註冊則本來就屬於 `apps/vscode`。
- 套件分層與邊界的強制方式見 ADR-0026。
