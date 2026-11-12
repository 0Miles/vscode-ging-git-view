---
status: accepted
---

# host ports 依需要長出來、按宿主能力分組,只放 dispatch 今天會呼叫的方法

圖形的 message dispatch(`registerMessageHandlers`)與 webview bridge 已經搬進 `packages/core`,不 import `vscode`。它向宿主(`GLOSSARY.md` 的 **Host**:VS Code,之後還有桌面版)要的東西,全部透過 [ports.ts](../../packages/core/src/host/ports.ts) 裡的 port。截至 #295 共 9 個 —— `HostConfig`、`HostStorage`、`Prompts`、`Opener`、`Clipboard`、`Watcher`、`L10n`、`RepoSource`、`HostLogger` —— 其中 `HostStorage` 餵的是 core 的 `ExtensionState`(見下),其餘包成 `HostPorts` 交給 dispatch。

切法有三條規則:**依需要長出來**(先有呼叫端,才有方法)、**按宿主能力分組**(一個 port 是宿主的一種能力,不是一個方法,也不是整個宿主)、**只放 dispatch 與它旁邊的 core 服務今天真的會呼叫的方法**。port 是結構式的 interface,形狀比照 #294 的 `AvatarConfig` / `AvatarStore`,所以宿主常常能直接交出現成的物件:VS Code 這邊的 `HostConfig` 就是既有的 `Config`,`RepoSource` 就是 `RepoManager`。型別一律宿主中立 —— 路徑是字串不是 URI,被取消的詢問回答 `undefined`。VS Code 的實作在 [hostPorts.ts](../../apps/vscode/src/hostPorts.ts),每個方法只轉呼叫一次 VS Code API。

## 為什麼未來的讀者會困惑

- **`Prompts` 沒有 quick pick,也沒有 confirm,但 #295 的票面列了。** 不是漏做。dispatch 沒有任何地方呼叫它們 —— 圖形要問使用者的事,用的是 webview 自己的對話框 —— 所以照「先有呼叫端」的規則,它們不存在。今天 `Prompts` 有的是通知三種(`showInformation`、`showWarning`、`showError`)、存檔位置,以及 askpass 用的 `input`。它們真正會長出來的地方是 [#339](https://github.com/0Miles/vscode-ging-git-view/issues/339):把 `extension.ts` 命令 handler 裡的 git 操作搬進 core 時,那些 handler 的 `showQuickPick` 與確認框才會第一次需要宿主中立的版本,屆時照著那些呼叫端的形狀加。
- **`showAllBranches`、`configurePullRequestProvider`、`openScmView` 不是 port,是 `MessageHandlerDeps` 的 hook。** 它們跳回的是擴充功能自己的 VS Code 介面:側檢視標題列的 Show All 命令(ADR-0018 的 direct write)、管理 pull request provider 的 QuickPick 命令(ADR-0021)、VS Code 的原始檔控制檢視。這些不是「宿主的能力」—— 剪貼簿每個宿主都有,而「側檢視的 Show All」是 VS Code 版側檢視自己的功能,桌面版的側檢視要在 webview 裡重做,到時它長什麼樣還沒定。所以它們留在 hook,跟 `onSelectRepo`、`onDelegatedRan` 放在一起,一個請求對應一個函式。
- **current repository 的保存走 `HostStorage`,沒有 `setLastActiveRepo` 這個 port。** `ExtensionState` 整個搬進 core,改成架在 `HostStorage` 上:兩層 key-value(`workspace`、`global`)加上全域儲存的資料夾。讀的規則見 `GLOSSARY.md` 的 **Current repository**。寫的規則 —— 既不是 known repository、路徑也不可用的值,記成「沒有選取」而不是照存 —— 在 `ExtensionState.setLastActiveRepo` 裡,理由只寫在它的註解中。若 port 開在 `setLastActiveRepo` 這一層,第二個宿主就得把寫的規則重寫一遍,讀的時候也得自己照規則解析;開在 key-value 這一層,兩邊的規則都留在 core,宿主只要交出最笨的儲存。
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
- **命令 handler 的 git 操作都在 core,`apps/vscode` 只註冊命令,這條由 lint 守住。** #339 把 `extension.ts` 命令 handler 裡的 git 流程(fetch 與自動 fetch、remote 管理、reflog、user details、version info、statistics)搬進 core 的命令服務([fetchService.ts](../../packages/core/src/extension/fetchService.ts)、[remoteCommands.ts](../../packages/core/src/extension/remoteCommands.ts)、[reflogCommand.ts](../../packages/core/src/extension/reflogCommand.ts)、[infoCommands.ts](../../packages/core/src/extension/infoCommands.ts),共用 [commandKit.ts](../../packages/core/src/extension/commandKit.ts))。`.oxlintrc.json` 對 `apps/vscode/src/**` 設了 `no-restricted-imports`:不能 value import `@ging/core/backend/actions/**` 與 `queries/**`(含更深的子路徑),`import type` 可以。白名單只有兩處。一是 `DiffDocProvider` 的 reader(`queries/commitFileContent`,在規則的 pattern 裡放行):revision 在建立 URI 之前就換算好了,剩下唯一跟宿主有關的是 VS Code 依 workspace folder scope 解析的 `fileEncoding`。二是 `blameController` 的 blame 與 `gitDirs` 查詢(在那幾行 import 上逐行關掉):查詢本身在 core,這個檔案只剩 decoration、cache、排程這些 editor 接線。規則不看 git client 的方法呼叫(例如 `.raw(`),今天 `apps/vscode/src` 沒有這種呼叫。規則也不看動態 `import()`,今天 `apps/vscode/src` 沒有任何動態 `import()`。側檢視(TreeView)與命令註冊本來就屬於 `apps/vscode`。
- 套件分層與邊界的強制方式見 ADR-0026。

## 補記(2026-11-11,#352)

**`Prompts` 長出了 `pick` 與 `pickMany`,`confirm` 換成更一般的 `choose`,`input` 的 `placeholder` 與 `password` 改成選填。每一項都對得到 #339 與 #337 搬進 core 的命令流程,只有 `description` 與 `matchOnDescription` 是替已排定的下一張票先加的。**

「為什麼未來的讀者會困惑」第一條說 `Prompts` 沒有 quick pick 也沒有 confirm,要等 #339 的呼叫端出現。#336 先加了 `confirm` 與 `input` 的 `value`(ADR-0029);#352 把 remote 管理搬進 core 的 [remoteCommands.ts](../../packages/core/src/extension/remoteCommands.ts),`fetchRemote` 命令搬進 [fetchService.ts](../../packages/core/src/extension/fetchService.ts),其餘的就照著這些呼叫端長出來:

- **`pick(items, { placeholder?, matchOnDescription? })` 與 `pickMany(items, 同上)`**,每一列是 `{ label, description?, picked?, value }`。`pick` 回答選中那一列的 `value`,`pickMany` 回答打勾那幾列的 `value`(一列都沒勾也是回答)。`pick` 的呼叫端是 Manage Remotes 的兩層選單,以及 `fetchRemote` 在幾個 remote 之間挑一個;`pickMany` 加 `picked` 的是 Show/Hide Remotes。票面原本寫的是一個 `pick` 加上 `canPickMany`,但回答的型別隨這個旗標改變,port、VS Code 實作與 fake 就得各寫一組 overload,所以拆成兩個方法。回答 `value` 而不是 label,是因為 label 不一定認得出是哪一列:Manage Remotes 的「新增」那一列,跟一個剛好同名的 remote,看 label 是分不出來的。
- **`description` 與 `matchOnDescription` 今天沒有呼叫端。** 它們是 S3(#353)的 `viewReflog` 要的:每一列的描述是 reflog selector,而且要能用它搜尋。#352 的票面把它們一起列進來,讓 S3 不必再開一次這個 port。這是對「先有呼叫端」的一次有意的提前:呼叫端已經排定,形狀是照著現在 `viewReflog` 的 `showQuickPick` 抄的,不是猜的。
- **`choose(message, { detail?, actions: { label, value }[] })`,固定是 modal,回答按下那個動作的 `value`,取消或 Esc 是 `undefined`。** #336 加的是 `confirm(message, ...actions)`,回答選中的那個 label;票面要的是 `confirm(message, { confirmLabel }) → boolean`。兩者都裝不下同時進行的 #337(stash 的 apply / pop):它要多一行 `detail`、兩個動作按鈕,而且要知道按的是哪一個。所以 port 上只有 `choose`;「只有一種說是的方式」這個最常見的情況,是 core 的 `confirm(prompts, message, confirmLabel)`([commandKit.ts](../../packages/core/src/extension/commandKit.ts)),只是 `choose` 上的一層糖,不是 port 方法。它的呼叫端是 Stash 側檢視的 drop 與 remote 的 Remove(兩處),S3 的 reset 也會用它。
- **`input` 的 `placeholder`、`password` 改成選填。** 只有 askpass 會填;remote 與 stash 的輸入框都不填。
- **`ignoreFocusOut` 不在 port 上。** 失焦也不消失本來就是 `input` 的契約(見「後果」第二條),所以 VS Code 的每個 `input` 都帶著它,呼叫端不必、也不能選。`pick` 與 `pickMany` 沒有這個保證,和搬移前的 `showQuickPick` 一樣。

`Prompts` 之外還有兩處:

- **`RepoSource.updateRepoState(repo, patch)`**:以寫入當下的 state 為準合併、寫入、廣播,repo 不在集合裡就什麼都不做。理由跟 `dropRepo` 相同:graph 自己留著一份 repo state,下次存任何東西時會整份寫回,沒聽到廣播的寫入就會被它蓋掉,所以寫入與廣播放在同一個方法裡。呼叫端是 Show/Hide Remotes,以及 VS Code 這邊兩處原本手寫這兩步的地方(側檢視的顯示切換、`setRepoName`)。
- **`RunRepoMutation` 的型別搬到 ports.ts。** 它是宿主交給 core 命令服務的 hook,不在 `HostPorts` 裡;放在 ports.ts,是讓 remote 命令不必只為了一個型別去 import fetch 服務。

「後果」第三條原本列的 fetch 與 remote 管理,現在都已經在 core。

## 補記(2026-11-11,#353)

**`PickItem` 長出了 `warning?`,一個語意旗標,不是圖示。core 不寫任何宿主的圖示語法;要畫成什麼,由宿主的 `Prompts` 決定。**

呼叫端是 [reflogCommand.ts](../../packages/core/src/extension/reflogCommand.ts) 的 dangling commit 那一列。搬移前它的 label 前面寫死了 VS Code 的 codicon `$(warning)`,桌面版的選單看不懂,只會原樣印出來。VS Code 這邊由 [quickPickItems.ts](../../apps/vscode/src/extension/quickPickItems.ts) 轉回 `$(warning) `。#352 先加的 `description` 與 `matchOnDescription` 也在這裡有了呼叫端。

同一張票要求 `packages/core/src` 裡不再有 codicon 語法,所以 blame hover([blameHover.ts](../../packages/core/src/extension/blameHover.ts))的三個圖示也改成跟宿主要:不是 port,是 `BlameHoverContext.icon(name)`,`name` 是封閉的語意名稱(`account`、`change`、`commit`),由 `blameController` 回答。hover 其餘的 VS Code 形狀(`command:` 連結、圖片的 `|width=` 寫法)不在範圍內,blame 的接線依 #339 留在 app。

## 補記(2026-11-11,#354)

**`Prompts.showInformation` 多了一個選填的 `{ modal?, actions? }`,回答按下那個動作的 `value`。沒有另開方法。**

呼叫端只有一個:Version Info([infoCommands.ts](../../packages/core/src/extension/infoCommands.ts))要一個 modal 的資訊框,上面一顆「複製」。它跟 `choose` 差在語氣:`choose` 是一個要使用者做決定的警告框,版本資訊只是告知,順便給一個動作。為了一個呼叫端開第二個 modal 方法,port 上就有兩個只差圖示的方法,所以照票面做成參數。

- **`actions` 的形狀跟 `choose` 一樣是 `{ label, value }`,不是 `showError` 的 label 字串。** 理由同 #352 的 `pick`:回答 `value`,兩個同名的動作也分得開。`showError` 沒有跟著改:它唯一帶動作的呼叫端(建立 pull request 時「設定這個 host」那一顆)只有一個動作,回答 label 就分得出來。
- **回傳型別一律是 `PromiseLike<T | undefined>`,沒有用 overload 把「沒有選項」的那個寫成 `void`。** 理由同 `pick` / `pickMany` 拆開的那一條:回傳型別隨參數改變,port、VS Code 實作與 fake 就得各寫一組 overload。這裡沒有拆成兩個方法,是因為沒有選項時回答恆為 `undefined`,呼叫端照舊不必 `await`,型別不會騙人;port 的註解寫明了這一點,所以既有的四個呼叫端沒有改。

Set Git User Details 寫的是使用者身分,Statistics 只是讀，畫面上都沒有東西因此改變，所以兩者都不進 `runRepoMutation`,失敗直接走 [commandKit.ts](../../packages/core/src/extension/commandKit.ts) 的 `tryOrToast`(#353 加的、kit 唯一的 catch)。

`runRepoMutation` 因此從 `CommandKitDeps` 拿出來，成了只有 `createMutatingCommandKit` 要的 `MutationDeps`:只有它的 `mutateOrToast` 會用到。不改變 repo 的服務(這裡的 info 命令)就不必、也不能交一個用不到的 hook;fetch、remote 與 reflog 的服務改用 mutating kit。

kit 也多了不出聲的 `currentRepo`,它和 `currentRepoOrSay` 一樣只認 known repository;自動 fetch 的計時器改用它，各個命令服務對「current repository」的判斷因此一致。Set Git User Details 在沒有 current repository 時不能像其他命令那樣說「沒有存放庫」就停，因為第一次設定時還沒有存放庫，要設的正是全域身分。所以它照樣問，只是範圍只剩「全域」。這時用的 client 是 `gitClientFor(null)`,不綁存放庫、在宿主程序所在的位置跑 git,和 Version Info 問 `git --version` 的是同一個。`null` 的意思寫在 `CommandKitDeps.gitClientFor` 與 `gitClientFactory` 上，桌面版的實作要照著做。

## 補記(2026-11-12,#385)

**`HostConfig` 多了 39 個方法,全是圖形頁面的 view state 要讀的設定;`repoSettingDefaults()` 的回傳型別從 `RepoScopeSettings` 放寬成 `RepoSettingDefaults`。呼叫端是 core 的 [graphViewState.ts](../../packages/core/src/extension/graphViewState.ts)。**

`GitGraphViewState` 原本由 `apps/vscode` 的 `webviewHtml.ts` 從 `Config` 逐欄位組出來。兩個宿主都要組同一份,各寫一份就會漂移,所以組裝搬進 core 的 `buildGraphViewState`,只依賴 `HostConfig`、`RepoSource` 與 `ExtensionState`。CSP、nonce、`<script>` 注入這些頁面骨架仍是宿主的事。

- **沒有另開一個「view state 設定」port。** 這些都是設定,而設定這種能力已經有 `HostConfig`;另開一個 port,宿主就得把同一處實作(VS Code 是 `Config`)交兩次。代價是 `HostConfig` 變長。新方法在 ports.ts 裡集中成一段,註明只有 `buildGraphViewState` 會讀:每個方法對應 view state 裡同名的欄位,型別也照那個欄位。
- **`repoSettingDefaults()` 放寬,不是新增方法。** view state 要的是連同兩個隱藏開關的整份預設值(Repository Settings 抽屜要顯示它們),dispatch 用的 `resolveRepoScope` 只看其中的 load scope。VS Code 的 `Config` 本來就回答整份,所以實作沒有改。
- **`scmMultiRepoSelection()` 是 VS Code 的原始檔控制檢視的模式,但仍放在 `HostConfig`。** webview 只用它決定要不要給存放庫下拉選單;沒有原始檔控制檢視的宿主照自己的選單回答。
- **`fetchAvatars()` 只是設定本身。** view state 的 `fetchAvatars` 還要有地方放頭像(`ExtensionState.isAvatarStorageAvailable`),這條在 core 算。

同一張票把 `branchFilterStore` 搬進 core([branchFilterStore.ts](../../packages/core/src/extension/branchFilterStore.ts))。它不是 port:是 core 的服務,側檢視與 dispatch 共用同一個實例,宿主只負責建立它。它唯一的 VS Code 依賴是 `vscode.EventEmitter`,現在自己通知 listener,語意照 VS Code 的 emitter,寫在它的註解裡。
