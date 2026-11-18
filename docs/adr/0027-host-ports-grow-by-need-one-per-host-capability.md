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

## 補記(2026-11-13,#386)

**「app 不得直接跑 core 的 git 操作」這條 lint 規則擴及 `apps/desktop/src/**`,但上面的白名單只屬於 `apps/vscode`。\*\*

`apps/desktop` 是第二個宿主,它的 main process 一樣只該註冊命令、實作 port,git 流程留在 core 的命令服務。所以 `.oxlintrc.json` 對 `apps/desktop/src/**` 設了同樣的 `no-restricted-imports`,從第一行就適用。

兩個 app 各自一條 override,不共用一條:`apps/vscode` 那條的 pattern 放行 `queries/commitFileContent`,理由是 VS Code 的 `DiffDocProvider` 要依 workspace folder scope 解析 `fileEncoding`,這是 VS Code 才有的需要。桌面版沒有這個呼叫端,不繼承這個豁免。哪天桌面版真的要讀某個版本的檔案(#405),再照它自己的理由決定是在 core 開命令服務,還是在它那條 override 加白名單。`blameController` 那幾行逐行關掉規則的 import 也只在 `apps/vscode`。

## 補記(2026-11-13,#387)

**port 的契約有了可執行的版本:`Storage`、`Clipboard`、`Watcher`、`RepoSource` 各一份契約測試,放在 [packages/core/tests/contracts/](../../packages/core/tests/contracts/),同一份同時對 `fakeHost` 與桌面版的實作跑(ADR-0032 的第一層)。**

「後果」第二條說 port 的註解就是契約。註解寫得出來,但寫不出「這份實作有沒有照著做」,所以這四個 port 的契約改寫成測試:每份是一個 `describe…Contract(name, make)`,`make` 交出受測的實作,以及測試從 port 外面觀察它所需的東西(剪貼簿現在放著什麼、圖形被重新整理了幾次、廣播了哪些集合)。core 在 [fakeHost.contract.test.ts](../../packages/core/tests/fakeHost.contract.test.ts) 對 `fakeHost` 跑,桌面版在 `apps/desktop/tests/ports/` 對自己的實作跑。所以 core 給測試用的匯出從 ADR-0026 列的 `./tests/helpers` 一條,放寬成 `./tests/*`,`./tests/helpers` 與 `./tests/contracts/*` 都經由它取得,一樣只給測試用。

- **`fakeHost` 因此從「只記錄」改成「照契約行為」。** 之前它的 `RepoSource` 永遠回答同一個集合、`Watcher` 只記下被呼叫過,dispatch 的測試看不出 fake 跟真的宿主行為不一樣。現在剪貼簿會留著寫進去的字,`Watcher` 在 mute 之外會為外部變更重新整理,`RepoSource` 真的保存與廣播集合;`calls` 的紀錄不變。`answers.reposChanged` 換成 `answers.goneRepos`(`checkReposExist` 會發現已經不存在的那些)。`HostStorage` 原本沒有 fake,新增了 `fakeStorage`。
- **契約只寫 port 註解說得出口的事。** 例如 `Watcher` 不測防彈跳的時間、`RepoSource` 不測「丟掉一個不認識的存放庫」會不會廣播:那些是各宿主自己的選擇,寫進契約就等於替 port 加了註解沒有的承諾。各實作自己的行為留在各自的測試裡。
- **`L10n`、`HostConfig`、`HostLogger`、`Prompts`、`Opener` 沒有契約測試。** 前三個的「契約」幾乎就是型別,fake 的回答本來就是測試隨意定的;後兩個的桌面實作在 #390 等票。

「後果」第一條因此多一步:在這四個 port 上加方法時,契約測試也要跟著補,`fakeHost` 與每個宿主才會一起被檢查。

## 補記(2026-11-13,#388)

**`AskpassManager` 長出了 `route(prompts)`:整個行程一個 server,每個詢問者一條 route。route 的 env 帶 `NEO_GIT_GRAPH_ASKPASS_TOKEN`,`askpassMain` 把它送回 server,server 問那條 route 的 `Prompts`。**

桌面版的 main process 每個 webview 實例一組 dispatch 與 ports(#393 的分頁各一個),git 要認證時,要問的是發起那次 git 的實例。server 若每個實例各開一個,每個都是一條 named pipe 或 socket,關掉一個分頁就得記得收一個;用 token 路由,server 只有一個,實例拿到的只是一個可以 `dispose` 的 route。

- **沒有 token 的請求照舊問建構時給的 `prompts`。** VS Code 只用 `getEnv()`,env 裡沒有 token,請求本文也就沒有 `token` 欄位(`JSON.stringify` 略過 `undefined`),所以它的行為沒有變。
- **token 對不上任何 route,回答「取消」,不問任何人。** 那是已經關掉的實例跑的 git;把它的密碼提示轉給另一個視窗,使用者會在不相干的分頁裡被問一個不相干 repo 的帳密。
- **`AvatarManager` 同一張票改成可以註冊多個 bridge。** 頭像快取全域一份,每個頭像扇出到所有已註冊的 bridge,`deregisterBridge(post)` 只移除給它的那一個。VS Code 同時只有一個面板的 bridge,行為不變。
- **桌面版的 `Prompts` 與 `Opener` 目前是過渡版。** `Prompts` 只實作 dispatch 用到的通知三種與 `pickSaveLocation`(系統對話框,經過可注入的 `NativeDialogs`,見 ADR-0032),其餘回答「取消」並寫 log,#390 取代它;`Opener` 與 dispatch 的 hook 一律寫 log,#391 補上。

**桌面版 main process 每一個單例的處置。** 票面的表列了前八列，並且說「表上沒列到的單例視為缺漏」,所以其餘的也列在這裡。實作在 `apps/desktop/src/graphInstance.ts`(每個實例一份)與 `sharedServices.ts`(全行程共用)。

| 單例                                                            | 處置                                | 理由                                                                                                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitClient`(連同它的 env)                                       | 每個實例一個                        | env 帶該實例 askpass route 的 token 與它自己的 sequence editor                                                                                                                                  |
| `SequenceEditorManager`                                         | 每個實例一個                        | 共用的話，兩個實例同時 interactive rebase 會搶同一個 todo 檔,`wasApplied` 會誤判                                                                                                                |
| auto-fetch 計時器                                               | 每個實例一個                        | 各自 fetch 自己的 current repository,經 core 的 `createRunRepoMutation` 包住自己的 watcher                                                                                                      |
| askpass server                                                  | 全域一個                            | 依 token 路由回發起的實例，見上;多分頁的路由在 #393                                                                                                                                             |
| `AvatarManager`                                                 | 全域一個                            | 快取共用，頭像扇出到每個已註冊的 bridge,`deregisterBridge` 只移除自己那一個                                                                                                                     |
| `branchFacts` 的作廢                                            | 全域一個                            | 刻意的選擇：代價是某個實例 mutate 時，其他實例的快取多清一次                                                                                                                                    |
| `branchActionDelegate`                                          | 桌面不使用                          | 側檢視和圖形在同一個 webview(#399)                                                                                                                                                              |
| `ExtensionState` 的分頁版                                       | 不在本票                            | 現在全域一份,current repository 是 app 的;#393 改成每個 Tab 一份                                                                                                                                |
| `branchFilterStore`                                             | 全域一個                            | 篩選以 repo 為鍵。前提是**同一個存放庫同一時間至多開在一個 Tab**(GLOSSARY.md 的 **Tab**),所以實例之間不會共用同一筆。**#393 必須守住這個前提**:同一個 repo 若開在兩個分頁，它們的篩選會互相連動 |
| `branchCleanup`                                                 | 全域一個                            | 沒有自己的狀態，每次都從 `branchFacts` 為被問到的 repo 建 payload                                                                                                                               |
| `RepoSource`(known repositories)                                | 全域一個                            | 桌面版的 known repositories 是 app 的最近使用清單，不是某個 Tab 的;各實例的 boot repo 以自己的 current repository 算(`pickBootRepo`)                                                            |
| `HostConfig`(desktop config 與設定檔)                           | 全域一個                            | 設定是 app 的                                                                                                                                                                                   |
| `L10n`                                                          | 全域一個                            | 語系是 app 的                                                                                                                                                                                   |
| `HostLogger`                                                    | 全域一個                            | 一個 log 檔;single-instance lock 的範圍就是它所在的 user data 資料夾                                                                                                                            |
| `Clipboard`                                                     | 全域一個                            | 系統只有一個剪貼簿                                                                                                                                                                              |
| `Opener`(過渡版)                                                | 全域一個                            | 目前只寫 log;#391 實作時再決定要不要依視窗                                                                                                                                                      |
| 讀取用的 git client(`branchFacts` 與 `branchCleanup` 的 reader) | 全域一個工廠，每次呼叫建一個 client | 只讀，不帶 askpass 與 sequence editor 的 env:它們不詢問、不 rebase,也不需要任何實例的 token                                                                                                     |
| `Watcher`                                                       | 每個實例一個                        | 看的是該實例的 current repository,mute 的是該實例自己的 mutation                                                                                                                                |
| `Prompts`(過渡版)                                               | 每個實例一個                        | 附著在它的視窗上;askpass 的 route 也是這一份                                                                                                                                                    |

## 補記(2026-11-17,#390)

**桌面版的 `Prompts` 不再是過渡版。** [prompts.ts](../../apps/desktop/src/ports/prompts.ts) 的 `createDesktopPrompts` 取代 `createInterimPrompts`,仍是每個 webview 實例一份(上表「`Prompts`(過渡版)」那一列的處置不變,只是不再是過渡版):

- **pick、pickMany、choose、input** 問在那個實例自己的頁面上,畫在 webview 桌面入口的 host prompt overlay 裡,協定與 overlay 的位置見 ADR-0031 的同日補記。`input` 失焦不消失(「後果」第二條)由 overlay 是 modal 保證:它只在回答或取消時關。`pick` 與 `pickMany` 也不因失焦消失;port 的註解說「可以」消失,不是「必須」。
- **三種通知與 `pickSaveLocation`** 照舊是系統原生的對話框,經過 `NativeDialogs`(ADR-0032)。票面只把四種詢問移進頁面;通知沒有「一格被進度框占住」的問題,存檔位置本來就該是系統的檔案對話框。
- **`PickItem.warning`** 在 overlay 畫成警告圖示,label 本身不帶任何圖示語法。
- 它多了三個 port 以外的方法,由 main process 呼叫:`receive`(頁面的回覆)、`pageLoading`(頁面重新載入,未回答的 prompt 等新頁面準備好後重送)、`dispose`(實例結束,未回答的一律回答取消)。

## 補記(2026-11-17,#397)

**`HostConfig` 長出了 `update(key, value)`:寫進使用者的全域設定,不帶 scope。呼叫端是桌面版的設定頁,core 自己今天不呼叫它。**

票面要求三邊一起補(port、VS Code 的 `Config`、`fakeHost`),所以這是 port 上第一個「呼叫端在宿主、不在 core」的方法。放在 `HostConfig` 而不是桌面版自己的介面,是因為「寫一個設定」本來就是每個宿主都有的能力,之後 C6(#398)把 `managePullRequestProviders` 搬進 core 時,core 會是第二個呼叫端,屆時不必再開一次 port。

- **key 照 settings.json 的寫法給全名**(`ging-git-view.autoFetch.intervalMinutes`),不是去掉 section 的名字。桌面版的設定檔、設定頁的列 id、`REPO_SETTING_DEFAULT_KEYS` 都用全名,呼叫端不必為了這一個方法換一套拼法。VS Code 的實作因此用不帶 section 的 `getConfiguration()` 寫到 `ConfigurationTarget.Global`;不認得的 key 由 VS Code 自己拒絕。
- **寫入不負責推送。** port 只寫;寫完之後誰要被告知(auto-fetch 計時器、圖形的 Repository Setting 預設值),由宿主照它對「設定變了」本來的反應去做。VS Code 有 `onDidChangeConfiguration`,所以 `update` 之後什麼都不用多做;桌面版沒有,所以設定頁寫入成功後,main process 對每個 graph instance 呼叫 `settingChanged`([settingsPush.ts](../../apps/desktop/src/settingsPush.ts))。把推送放進 `update`,VS Code 那邊就會推兩次。
- **桌面版的寫入比讀取嚴格。** 讀的時候,超出範圍的數字會被夾回範圍、清單裡不合格的項目會被丟掉(#387,使用者手寫的檔案能用多少用多少);寫的時候這些一律拒絕(`SettingRefused`),因為寫入的一方是設定頁,使用者就在那裡,告訴他比默默改掉他輸入的值好。設定檔不是 JSON 時也拒絕寫入:那是使用者的檔案,寫進去就蓋掉他寫的東西。
- **`REPO_SETTING_DEFAULT_KEYS` 從 `apps/vscode` 的 `config.ts` 搬到 core 的 [repoSettings.ts](../../packages/core/src/extension/repoSettings.ts)。** 兩個宿主都要從「哪個 key 變了」算出 `setRepoSettingDefaults` 的 `changed`,各寫一份就會漂移。VS Code 這邊只改了 import。

## 補記(2026-11-17,#391)

**桌面版的 `Opener` 不再是過渡版,而且改成每個 webview 實例一份。** [opener.ts](../../apps/desktop/src/ports/opener.ts) 的 `createDesktopOpener` 取代 `createInterimOpener`,由 [graphInstance.ts](../../apps/desktop/src/graphInstance.ts) 用該實例自己的 `Prompts` 建出來。上表「`Opener`(過渡版)」那一列的處置改為「每個實例一個」:`Opener` 有話要說(stub 的通知、終端機開不起來)時,要說在發起那次請求的視窗裡,而全域一份的 `Opener` 不知道是哪個視窗。系統那一側(Electron 的 `shell` 與啟動終端機)沒有狀態,所以是全域一份的 `OsShell`,放在 `SharedServices.os`。

- **`openFile` 只把「已知只會被顯示」的型別交給系統預設程式(`shell.openPath`),其他一律在檔案總管裡選取它(`shell.showItemInFolder`),照樣回答成功;開不了時 reject。** 判斷用的是允許清單(`opensDirectly`:圖片、PDF、純文字與 Markdown、資料與設定檔、編譯型語言的原始碼),不是「會執行的副檔名」清單:哪個型別由哪個程式開，是系統與每個裝上去的 app 自己註冊的，黑名單永遠列不完(捷徑、安裝檔、script host、系統會套用的設定檔、說明檔…),漏一個就是執行別人 repo 裡的程式;允許清單漏一個只是多開一個資料夾視窗。刻意不列:某個平台開啟時會執行的 script(Windows 的 `.js`、`.vbs`,有直譯器註冊時的 `.py`、`.rb`,`.sh`、`.ps1`、`.bat`),以及瀏覽器會連 script 一起開的 `.html`、`.svg`、`.xml`;沒有副檔名的檔案也一律選取。另外三道:判斷的是 `fs.realpath.native` 之後的真實路徑(連結指向什麼就判斷什麼),而且必須在該實例目前 repository 的真實路徑底下(`..`、絕對路徑、指出 repo 的連結都 reject);非 Windows 上有執行位元的檔案不開(macOS 會在終端機裡執行它，不看檔名);Windows 上 `PATHEXT` 列到的型別不開，檔名結尾的點與空白不算副檔名(`a.bat.`),磁碟代號以外出現 `:` 的路徑(`a.bat::$DATA` 這種 stream)直接 reject。代價：沒列到的型別(例如 `Makefile`、`.html`)點下去只會開資料夾。
- **`openExternalUrl` 只放行 `http:` / `https:`,交給瀏覽器的是 `new URL()` 解析後的 `href`,不是檢查過的原字串(`webUrl`);其他寫 log 後不開。** 呼叫端是 issue 連結(使用者設定拼出來的 URL)與設定頁的描述連結;`file:` 或自訂 scheme 交給系統等於叫它執行東西。app 的每個頁面(視窗自己的頁面、每個 Tab 的 view、設定視窗)都只經過同一個 guard:#393 的 `keepPageInPlace`([pageGuard.ts](../../apps/desktop/src/pageGuard.ts)),它擋下頁面要求的每個導覽與新視窗，把要求的 URL 交給 `openWebUrl`,由它決定放不放行;頁面上的 `<a>`、`window.open` 都繞不過它(app 自己的 `loadURL` 與重新載入不算導覽)。ADR-0031 的 #397 補記說的「點下去暫時只會留一行 log」到此結束。開啟失敗只寫 log:這個方法沒有回傳值，設定視窗也沒有 `Prompts`。
- **`openTerminal` 開系統的終端機**([terminal.ts](../../apps/desktop/src/terminal.ts)),每個程式都用絕對路徑指名，從不讓系統去找:終端機的工作目錄就是 repo,而 Windows 找程式時會先找目前目錄。Windows 用 `ComSpec /d /c start "<title>" "<ComSpec>"`(`ComSpec` 不是絕對路徑時改用 `SystemRoot\System32\cmd.exe`;與 VS Code 的外部終端機同一招，Windows 11 上會由預設終端機應用程式接手;`cmd /c` 連引號裡的 `%VAR%` 都會展開，所以標題去掉 `%` 與 `"`),macOS 用 `/usr/bin/open -a Terminal <cwd>`,Linux 依序找 `x-terminal-emulator`、桌面環境自己的(gnome-terminal / konsole / xfce4-terminal)、`xterm`,只在 `PATH` 的絕對路徑資料夾裡找(空字串與 `.` 這類相對項目會對著 repo 解析，跳過),找不到的不試。一律 detached、不接 stdio。要求的資料夾也必須在發出請求的 Tab 的 repository 真實路徑底下(與 `openFile` 同一個 `repoRoot`),否則不開。開不起來時寫 log,並在該實例的視窗用 `showError` 說。
- **四個 stub:`openFileAtRevision`(→ #405)、`diffWithWorking`(→ #404)、`openCommitDiff`(→ #404)、`openMergeEditor`(→ #410)。** 先通知「GING 桌面版尚未支援這項功能」(`desktop.notSupportedYet`,`showInformation`,不等它被關掉),再 resolve,`openCommitDiff` 回 `true`。這是刻意偏離 port 註解「開不了就 reject」的契約:reject 的話,圖形會再跳一個自己的「無法開啟」錯誤框,使用者會看到兩個框,其中一個說的是錯的。偏離只在桌面實作的註解裡寫明,port 本身的契約不變;取代它的 D 票把 stub 換成真實作時一併移除。log 用 `log` 而不是 `logError`:這不是錯誤。

**`MessageHandlerDeps` 的 5 個 hook 在桌面版的處置:**

| hook                           | 處置                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `onSelectRepo`                 | no-op(沒有側檢視要跟著換 repo);只更新實例自己的 current repository,auto-fetch 讀它                                      |
| `onDelegatedRan`               | no-op:側檢視與圖形會在同一個頁面(#399),沒有要為 reload 留著的委派訊息                                                   |
| `showAllBranches`              | no-op,#399 改成真實作。圖形的篩選 chip 清不掉篩選;dispatch 照樣回 `branchFilterCleared`,圖形不會一直等                  |
| `configurePullRequestProvider` | core 的 Manage Pull Request Providers(#398 合併後取代原本的 stub),問在該實例自己的頁面,「顯示設定」打開設定視窗的那一列 |
| `openScmView`                  | stub:通知尚未支援,#403 的 working tree 檢視取代                                                                         |

## 補記(2026-11-17,#393)

**`ExtensionState` 每個 Tab 一份:建構時可以注入 `CurrentRepoSlot`,也就是「current repository 的路徑字串存在哪裡」。不注入時是 workspace 層的 `lastActiveRepo`,VS Code 的 key 與行為都沒變。** 上面 #388 的表裡「`ExtensionState` 的分頁版：不在本票」那一列，由本票完成。

- **slot 只管字串存哪裡，規則留在 `ExtensionState`。** 讀的時候照舊經過 `resolveCurrentRepo`,寫的時候照舊是 `setLastActiveRepo` 的「不是 known repository、路徑也不可用，就記成沒有選取」。這和「`HostStorage` 開在 key-value 層」那一條的理由相同：開在規則之下，第二個宿主就不必重寫規則。
- **分頁清單由 core 的 [tabStates.ts](../../packages/core/src/tabStates.ts) 保存，放在 workspace 層的 `openTabs`:** 依序列出每個 Tab 的路徑字串，以及聚焦的是哪一個。每個 Tab 的 `ExtensionState` 由它建立,slot 是清單裡那一格;Tab 自己寫入 current repository 時，整份清單跟著寫回。順序與聚焦由桌面版的分頁模型([tabs.ts](../../apps/desktop/src/tabs.ts))決定，它每次改變就把清單交給 `TabStates.save`,`TabStates` 不自己排序。
- **路徑不再 resolve 的 Tab,重啟時照樣出現(內容是說明頁),字串留在清單裡，直到使用者關掉它。** 這是 GLOSSARY「字串留著不刪」套到 Tab 上的結果：沒有任何探測分得出「已刪除」與「這次沒掛載」。
- **`branchFilterStore` 的前提(同一個存放庫至多開在一個 Tab)由三處守住。** 一是開啟：以 `resolveToKnownRepo` 比對已開的 Tab 與 known repositories,同一個存放庫的另一種拼法會聚焦既有的 Tab([tabWindow.ts](../../apps/desktop/src/tabWindow.ts))。二是每個實例交給圖形的 `RepoSource` 只有自己那一個 repo:`getRepos` 與 `loadRepos` 的廣播都只含它，`getBootRepo` 也只回答它(不在 known set 時回答 `null`),不像 `pickBootRepo` 那樣退到別的 known repository。圖形因此沒有別的 repo 可以挑：沒有存放庫下拉選單、CDV 檔案樹點子存放庫(#155)也不會切過去、它自己的 repo 被移出集合時也不會跟著 `loadRepos` 換到別的 Tab 開著的 repo。三是頁面仍送來別的 repo 的 `selectRepo` 時，實例在 channel 上就把它擋下、寫一行 log,dispatch 聽不到，Tab 的 current repository 不變。
  - **為什麼不改成「把 `selectRepo` 轉給分頁(聚焦或開新 Tab)」。** 那要在圖形已經在頁面上切過去之後再把它拉回原本的 repo,等於桌面版要替 `gitGraphView.ts` 的切換流程補一條撤銷路徑;而今天桌面版沒有任何一個入口真的會切 repo(下拉選單本來就關著,`scmMultiRepoSelection: false`)。只給它自己的 repo,圖形從一開始就沒有東西可切，代價是桌面版暫時失去 #155 的「點子存放庫就切過去」。之後若要它，由開啟資料夾的 #394 讓子存放庫開在自己的 Tab。
- **桌面版 app 自己的那份 `ExtensionState` 仍在,** 管 known repositories、dialog memory 與頭像;它的 current repository 在桌面版不再被寫。

## 補記(2026-11-17,#398)

**`managePullRequestProviders` 搬進 core 的 [pullRequestProviderCommands.ts](../../packages/core/src/extension/pullRequestProviderCommands.ts),port 跟著它的呼叫端長出四處:`HostConfig.update` 多了選填的 `scope`、`HostConfig` 多了 `inspect`、`PickItem` 多了 `detail` 與 `separatorAbove`、`Prompts.input` 多了 `validate`。**

#397 的補記預告 core 會是 `update` 的第二個呼叫端，這張票就是那一個。VS Code 的外部行為不變，由 apps/vscode 的 `pullRequestProviders.test.ts` 在 VS Code 的 API 那一層釘住(搬移前先寫，搬移後原封不動通過)。

- **`update(key, value, scope?)`,`scope` 是 `"global" | "workspace"`。** 不給就是 `global`,#397 的呼叫端不用改。VS Code 照原本的對應寫到 `ConfigurationTarget.Global` / `Workspace`;桌面版只有一層設定檔，不管 `scope` 寫什麼都寫那一層。folder scope 不在型別裡:provider 是 host 的性質，不是某個資料夾的(ADR-0021),而且沒有其他 GING 設定會寫到 folder。
- **`inspect(key)` 回答 `{ source, scopes }`,不是 VS Code 的 `inspect` 原形。** 這個流程要知道的只有兩件事：值目前來自哪一層(`source`,陣列跨層不合併，編輯要寫回這一層才看得到)，以及這裡能寫哪幾層(`scopes`,取代原本的 `workspaceFolders === undefined`)。把 `globalValue` / `workspaceValue` / `workspaceFolderValue` 整包搬上 port,桌面版就得為一個它沒有的模型回答一堆 `undefined`。`scopes` 放在 `inspect` 而不是另開方法，因為「能寫哪幾層」在 VS Code 本來就依 key 而定(application 範圍的設定不能寫到 workspace)。桌面版回答 `{ source: 檔案裡有這個 key ? "global" : null, scopes: ["global"] }`,所以它永遠不會問「要存到哪一層」。
- **`PickItem.detail` 與 `separatorAbove`。** 原本的 QuickPick 每個 forge 底下有一行範例 URL,「新增」那一列和 host 清單之間有一條分隔線。少了它們 VS Code 的畫面就變了。分隔線做成「這一列上方有一條線」的旗標，而不是一種沒有 `value` 的列：那樣 `pick` 的回答型別就得排除它，三個實作都要多一道過濾。VS Code 由 `quickPickItems` 在那一列前面插入 `QuickPickItemKind.Separator`;桌面版的 overlay 畫成上框線,`detail` 畫成第二行，不參與篩選(與 VS Code 預設的 `matchOnDetail: false` 相同)。
- **`Prompts.input` 的 `validate(text) → string | undefined`。** 原本的 `showInputBox` 有 `validateInput`,邊打邊檢查,Enter 在不合格時無效。VS Code 照原樣接上。桌面版的頁面跑不了 main process 的函式，所以改成「回答之後才檢查」:不合格就從那段文字重問一次，帶著原因(host prompt 的 input 多了 `error`,overlay 以 `role="alert"` 顯示)。兩邊共同的保證寫在 port 上:prompt 不會用 `validate` 拒絕的文字回答。代價是桌面版要按下 Enter 才看得到原因，而且重問時 overlay 會關掉再開一次。重問是一個新的 prompt(新的 id),排在當時已在等的其他 prompt 後面，所以若有別的 prompt 在等(例如 askpass),它會先出現;port 的 alidate 註解寫明了宿主可以這樣做。
- **「顯示設定」不是 port,是命令服務的 `revealSetting` hook。** 理由同 remote 命令的 `refreshGraph`:它是宿主交給這個服務的一個動作，不是 dispatch 要的能力，也避免和同時在改 `Opener` 的 #391 撞在同一個 interface。VS Code 是 `workbench.action.openSettings`;桌面版是設定視窗的 `reveal(key)`:沒開著就以 `?setting=` 開一個新視窗，開在那個設定那一列;已經開著就不重新載入(會丟掉其他列裡打了還沒送出的內容，例如還不是合法 JSON 的文字),而是把那個設定現在的值以 `settingUpdated` 送過去，再送 `revealSetting` 讓頁面捲到那一列並標示出來。
- **桌面版寫入後沒有推送給各 graph instance。** `pullRequests.providers` 每次建立 pull request 時才讀，`pushSettingChange` 對它本來就什麼都不做。設定視窗若已開著而使用者沒有按「顯示設定」,它顯示的仍是舊值，這是設定頁本身的問題(它只聽自己寫入的回覆),見 #446。
- **`MessageHandlerDeps.configurePullRequestProvider` 仍是 hook,但桌面版不再是 stub。** 它在桌面版直接呼叫這個命令服務，問在發起 Create Pull Request 的那個 instance 的頁面上。上面「為什麼未來的讀者會困惑」第二條說它跳回的是 VS Code 自己的 QuickPick 命令，現在兩個宿主跑的是同一份流程;它仍是 hook,是因為 VS Code 那邊照舊經由已註冊的命令執行，命令面板的入口與錯誤框的按鈕走同一條路。

## 補記(2026-11-17,#403)

**`openScmView` 在桌面版不再是 stub:它打開圖形旁邊的 working tree 面板(ADR-0031 的同日補記)。** 上面 #391 那張 hook 表的 `openScmView` 一列由本票取代。它仍是 hook,不是 port:它跳回的是宿主自己的畫面,VS Code 是原始檔控制檢視,桌面版是同一頁裡的面板。

- **working tree 的 git 邏輯在 core 的 [workingTreeService.ts](../../packages/core/src/extension/workingTreeService.ts),不是 port,也不進 dispatch。** 它是一個命令服務(status、整檔 stage / unstage、commit),依賴的只有 git client、`signCommits()` 與 `RunRepoMutation`,用法跟 fetch 服務一樣。面板的訊息不是 `RequestMessage`(ADR-0031),所以桌面版的 graph instance 在交給 dispatch 之前就把它們攔下,交給這個服務([workingTree.ts](../../apps/desktop/src/workingTree.ts) 做訊息與服務之間的轉換)。`.oxlintrc.json` 的規則因此不必為桌面版開任何白名單:app 只 import 命令服務,不碰 `backend/actions` 或 `queries`。
- **每個改動都經過 `runRepoMutation`:watcher 在改動期間靜音,做完之後圖形重新整理。** commit 之後新的 commit 出現在圖形上,靠的就是這一次重新整理。graph instance 原本只為 fetch 服務建一個 `runRepoMutation`,現在兩個服務共用同一個。
- **status 用 `git --no-optional-locks status --porcelain=v2 -z` 讀。** 一般的 `git status` 可能順手刷新並寫回 index,寫的期間握著 `index.lock`,使用者接著按的 stage 或 commit 就會被拒(#451 是圖形自己那一份 `git status` 的同一個競爭);寫回 index 也會叫醒檔案監看,讓面板與圖形再讀一次。
- **簽章規則同 cherry-pick、revert、merge、rebase:`signCommits` 為 true 時加 `-S`,否則不加任何旗標,交給 git 的 `commit.gpgsign`。** 沒有金鑰管理 UI,也沒有 pinentry 整合(#291 的「不做」)。
- **「有沒有 commit」看 HEAD,不看 git 的結束碼。** 沒有東西可以 commit 時,git 只在 stdout 說一句、stderr 什麼都沒有,而 simple-git 對這種執行一律 resolve。所以 `commitChanges` 比較 commit 前後的 HEAD,沒變就拿 git 說的那句 reject。
- **衝突檔(unmerged)單獨列成一組,沒有任何按鈕,而且永遠到不了 `add` 或 `reset`。** 整檔 stage 一個衝突檔就是把它標成已解決,那是 #410 的範圍;本票只讓它們不從清單裡消失。所以 stage / unstage 一律點名檔案,沒有「全部」:不帶路徑的 `add -A` 會把衝突檔標成已解決,不帶路徑的 `reset` 會刪掉 `MERGE_HEAD`,整個 merge 就默默消失了。面板的 Stage All / Unstage All 送的是那一組列出的每個檔案(submodule 除外),core 在執行前再讀一次 unmerged 路徑、把它們剔掉,兩道防線各自成立。路徑經 `--pathspec-from-file` 加 `--pathspec-file-nul`(git 2.25+)交給 git,寫在暫存檔裡,不放命令列:Windows 的命令列只有約 32k 字元,而 Stage All 可能點名上千個檔案。
- **submodule 只顯示、不 stage。** porcelain v2 的 `sub` 欄位標出它,面板上那一列沒有按鈕,也不在 Stage All 裡:只有內部變更的 submodule 沒有東西可 stage,而 submodule 管理在 #291 的「不做」清單上。
- amend 與 sign-off(#407)會在同一個 commit 區加控制項,`commitChanges` 的輸入是物件,加欄位不必改呼叫端。

## 補記(2026-11-17,#394)

**core 多了 init:動作在 [init.ts](../../packages/core/src/backend/actions/init.ts),命令服務在 [repoInitCommand.ts](../../packages/core/src/extension/repoInitCommand.ts)。port 沒有長：選資料夾不是 port。**

- **命令服務只收一個已經選好的資料夾。** 「問使用者要一個資料夾」今天只有桌面版要(VS Code 有自己的「初始化存放庫」),照「先有呼叫端」不開在 `Prompts` 上;桌面版用自己的 `NativeDialogs`(ADR-0032)問，再把路徑交給 core。`apps/desktop` 不得直接跑 core 的 git 動作(上面的 lint 規則),所以 init 經過命令服務，失敗由它用 `Prompts.showError` 說，和其他命令服務一致。
- **init 用不綁 repo 的 client(`gitClientFor(null)`),資料夾寫在命令列上(`git init -- <folder>`、`git -C <folder>`)。** client 的 `baseDir` 必須已經存在，而 git 自己會建出還不存在的資料夾。資料夾若已經是某個 working tree 的頂端，就不重新初始化(會補上 template 的 hooks),直接回答它;在另一個 repo 裡面的資料夾照 `git init` 的語意得到自己的 repo。
- **最近使用清單就是 `RepoSource` 的 known set,不另立集合。** GLOSSARY 的 Known repository 在桌面版的定義就是最近使用清單，所以 [recentRepos.ts](../../apps/desktop/src/recentRepos.ts) 只多存「開啟的順序」(workspace 層的 `desktopRecentRepos`),列出時以 known set 為準：不在 set 裡的順序項目略過,set 裡沒有順序的放最後、依路徑排。順序只在開成 Tab 時更新(命令列、開啟資料夾、初始化、清單)，還原 Tab 不算「開啟」。
- **清單裡的資料夾不在了，照列，標成找不到。** 判準是 `resolveCurrentRepo` 那一組(資料夾在不在,`isUsableRepoPath` 的非同步版 `isUsableRepoPathAsync`),不是 `isGitRepository`:和 Current repository 一樣，分不出刪除與沒掛載，所以不自動刪。移除是使用者的事(清單上的「移除」,走 `dropRepo`);開在 Tab 裡的 repo 不移除，因為 Tab 的圖形是從 known set 拿到自己的 repo(上面 #393 的補記)。
  - **看磁碟不在 main process 的執行緒上同步做。** 一個不回應的網路分享,`fs.statSync` 會讓整個視窗凍住好幾秒。所以清單記著上一次看到的結果,`list()` 只讀它;`check()` 只在 Welcome page 顯示時(視窗頁面說它準備好、最後一個 Tab 關掉、known set 改變、從清單開啟之後)用非同步的 stat 再看一次，結果不同才通知重畫。同一個資料夾一次只看一個，卡住的那個不擋其他的。
  - **每個 Tab 的 `checkReposExist` 只看自己的 repo。** 原本 instance 的 `RepoSource` 沿用 app 共用的那一個，一個 Tab 的圖形載入失敗，就會對整個 known set 跑 `isGitRepository`、把當下連不到的全部刪掉，和上一條相反。現在它只在自己的 repo 已經不是 repo 時把自己移出 known set,其他項目不動;自己那一個該不該留著，是 #454 的事。
  - **被 `dropRepo` 移出 known set 的,順序紀錄也跟著清掉**(不論是誰移的)。**清單最多列 20 個**(`RECENT_REPOS_SHOWN`):app 初始大小的視窗裡 Welcome page 不必捲動就放得下的數量，也是每次要看的資料夾數的上限。超過的仍是 known repository —— 它的自訂名稱與圖形的狀態留著，再開一次就回到第一個 —— 只是不列出;不自動移除，那會刪掉使用者沒要刪的東西。
- **選到 bare repo 或 `.git` 資料夾時，不初始化。** `git rev-parse --show-prefix` 在兩者裡都回答空字串、exit 0,單看它會被當成 working tree 的頂端;所以先問 `--is-inside-work-tree`(core 的 `gitFolderPlace`)。init 在這種資料夾回答 `NoWorkTreeFolderError`,命令服務用 app 自己的字串(`init.noWorkTree`)說明;開啟資料夾選到它時不提議初始化，而是說它沒有 working tree 可以顯示。`repoToOpen` 因此多回答「為什麼打不開」(`missing` / `notRepository` / `noWorkTree`),清單上資料夾不在的項目說「找不到」,不說「不是 Git 存放庫」。
- **清單上的 repo 以 known set 的拼法比對。** git 今天給的拼法可能和 known set 裡的不同(symlink、8.3 短檔名、磁碟代號大小寫，見 #413),所以「它是不是清單上的那一個」經過 `TabWindow.resolve`(`resolveToKnownRepo`),和開成 Tab 時走同一條路。
- **子存放庫(#393 的 R5 留下的問題)由開啟資料夾處理，不由圖形切換。** 選到 submodule 或巢狀 repo 的資料夾時,`repoToOpen` 以 git 的 `--show-toplevel` 解析到它自己，開在自己的 Tab。CDV 檔案樹點子存放庫(#155)在桌面版仍然不切換：要讓它改成「開在新 Tab」,得讓圖形知道別的 repo,而那正是 R5 拿掉的。

## 補記(2026-11-17,#399)

**桌面版的 `showAllBranches` 不再是 no-op:它是 Tab 側檢視的 Show All,清空該 Tab 自己 repository 的 branch filter(`showAllRepo`,別的 repo 一律不清)。**上面 #391 補記那張表的這一列改為:

| hook              | 處置                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `showAllBranches` | 側檢視的 Show All(#399):清空自己 repository 的 filter,filter 的變更經 `onDidChangeFilter` 同時送給圖形與側檢視 |

- **`onSelectRepo`、`onDelegatedRan` 維持 no-op,理由變了一半。**`onSelectRepo`:Tab 只顯示自己的 repository,側檢視一開始就在它上面,沒有東西要跟著換。`onDelegatedRan`:側檢視不委派,直接呼叫同一頁的圖形(ADR-0033),沒有為 reload 留著的訊息。#388 表上「`branchActionDelegate`:桌面不使用」那一列因此成立,不是暫時的。
- **沒有新的 port。**側檢視的 main process 那一半([sideViews.ts](../../apps/desktop/src/sideViews.ts))用的都是既有的:`HostConfig`、`RepoSource.updateRepoState`(toggle)、`Prompts.showInformation`(批次動作全被扣除時的說明)、`Clipboard`(複製 remote URL),以及 core 的 `remoteCommands`、`fetchService`、`pullRequestProviderCommands`、`branchFacts`、`branchFilterStore`。`remoteCommands` 是每個實例一份,問在該實例自己的頁面。
- **repo state 的寫入由實例的 `RepoSource` 包一層通知側檢視。**VS Code 的 `RepoManager` 有 `onDidWriteRepoState`;桌面版的 `RepoSource` 沒有寫入事件(`setRepoState` 不廣播),所以 `graphInstance.ts` 交給 dispatch 與命令服務的那一份在 `setRepoState`、`updateRepoState` 前後比對三個側檢視欄位(`sideViewStateChanged`),動了才請側檢視重讀。Repository Settings 抽屜改了隱藏 inactive / merged 的設定,側檢視因此跟著變,和 VS Code 一樣。

## 補記(2026-11-17,#395)

**core 多了 clone:動作在 [clone.ts](../../packages/core/src/backend/actions/clone.ts),命令服務在 [repoCloneCommand.ts](../../packages/core/src/extension/repoCloneCommand.ts)。port 沒有長,和 #394 的 init 同一個形狀。**

- **問 URL、選資料夾、畫進度都是宿主的事。** 命令服務收已經決定好的 URL 與目的地,外加這一次 clone 自己的 `AbortSignal`、進度的 listener 與 git 的環境(誰來回答帳密的 askpass route)。「問一個資料夾」與「顯示進度」今天只有桌面版要(VS Code 有自己的 Git: Clone),照「先有呼叫端」不開在 `Prompts` 上;桌面版問 URL 用既有的 `Prompts.input`,命令服務交出 `urlProblem` 當它的 `validate`,所以「什麼 URL 不收」只有 core 一份規則。
- **clone 走 `spawnGit`,不走 simple-git。** 要逐段讀 stderr 的進度,也要能殺掉整棵行程;simple-git 兩者都沒有。`spawnGit` 因此多了選填的 `onStderr` 與 `ownProcessGroup`(後者見 ADR-0028 的同日補記)。
- **URL 的規則(`cloneUrlProblem`)。** 只收 git 自己的網路 scheme(http、https、ssh、git 與 ssh 的兩種別名)與 `file://`、scp 寫法 `[user@]host:path`、這台電腦上的完整路徑。拒絕:`<transport>::<address>`(`ext::` 會執行任意命令,`fd::` 等其他 remote helper 同樣是「找一個叫這名字的程式來跑」)、`-` 開頭(會被讀成選項)、相對路徑(會對著 git 剛好在的目錄解析)、控制字元(換行會切開 git 的 credential 請求)、其他 scheme、取不出資料夾名稱的。命令列一律是 `-c protocol.ext.allow=never clone --progress -- <url> <folder>`。
- **目的地照 VS Code 的 clone:選「放在哪個資料夾」,名稱照 git 的規則從 URL 取**(`cloneFolderName`,git 的 `git_url_basename` 在這些 URL 上的行為)。已存在而且不是空資料夾、或上層資料夾不在時,git 不跑,用 app 自己的字串說明。
- **log 與畫面上的 URL 去掉帳密**(`urlWithoutCredentials`):`https://user:token@host/…` 的 token 不寫進 log 檔。
- **失敗的原因先拿掉進度行再交給 `formatGitError`。** clone 的 stderr 有 `remote: Counting objects: …` 這類進度,`formatGitError` 會優先挑 `remote:` 開頭的行,選中的就會是進度而不是 git 的 `fatal:`。

## 補記(2026-11-17,#410)

**`Opener.openMergeEditor` 在桌面版不再是 stub:衝突檔交給使用者替 git 設定的 merge tool(`git mergetool`)。port 的契約註解跟著改寫:「交給宿主合併它的方式 —— 有 3-way merge editor 的宿主用它(VS Code,沒有時退回一般編輯器),沒有的宿主用使用者設定的 merge tool;不回答任何東西,結果由宿主自己說。」** 上面 #391 那四個 stub 裡的 `openMergeEditor`(→ #410)由本票取代;VS Code 的實作沒有改。內建的 3-way merge 不在這裡,是 #411。

- **git 的部分是 core 的命令服務 [conflictCommands.ts](../../packages/core/src/extension/conflictCommands.ts),不是 port。** 它問 git 設定了哪個工具、執行它、事後讀結果,依賴的是 git client、`Prompts`、`L10n` 與 `RunRepoMutation`,和其他命令服務一樣。桌面版的 `Opener` 只拿到一個 `mergeTool(filePath)` 函式(graph instance 用自己那一份服務建出來),所以 `opener.ts` 不 import 任何 git 的東西,`.oxlintrc.json` 的規則也不必開白名單。工作樹面板(ADR-0031 的同日補記)的「以 merge tool 開啟」走同一個服務。
- **執行的是 `git mergetool --no-prompt --tool=<工具> -- <路徑>`,經 core 的 `spawnGit`:參數是陣列,中間沒有 shell,stdin 一開始就關掉。** 票面擔心的互動卡住由這兩件事解決:`--no-prompt` 拿掉「按 Enter 開始」;git 其餘在 stdin 上的問題(不信任工具結束碼時的「Was the merge successful [y/n]?」、一邊刪除時的「(m)odified or (d)eleted?」)讀到 EOF,git 當成「否」。simple-git 的 `raw` 不關 stdin,用它會讓這些問題永遠等下去,所以不用它。沒有 timeout:工具是使用者的,他要開多久就多久;ADR-0028 的 kill 因此不會發生。票面的另一個做法(在系統終端機執行、`openTerminal` 帶指令)沒有採用:它要改 port,而且結果回不到 GING。
- **工具一定是使用者設定的:`merge.guitool`,沒有就 `merge.tool`(等同 `git mergetool --gui` 的解析),都沒有就用 `showError` 說怎麼設定,不執行任何東西。** 不帶 `--tool` 的 `git mergetool` 會自己從一張清單裡猜一個裝著的程式來跑,那是使用者從沒選過的程式。GUI 工具優先,是因為桌面版沒有終端機讓 vimdiff 這類工具跑。工具與它的 `mergetool.<名稱>.cmd` 來自使用者自己的 git 設定(包括 repo 的 `.git/config`,clone 不會帶來它),由 git 自己的 shell script 執行,這和使用者在終端機打 `git mergetool` 是同一件事。
- **檔名含 `*`、`?`、`[`、`\` 或以 `:` 開頭的檔案不交給 `git mergetool`,說明原因,請使用者在編輯器裡解決。** `git mergetool` 把路徑當 pathspec,`--literal-pathspecs` 與 `:(literal)` 它都不理(git 2.40.1 實測:`[ab].txt` 會去合 `a.txt`;`:(literal)` 找不到檔案;Windows 上反斜線跳脫失敗),所以這種名字交出去,合的可能是另一個檔案。
- **結果依 ADR-0030 判定:`git mergetool` 結束之後讀 unmerged 路徑,不看 git 的輸出或結束碼。** 解掉了就不說話,圖形與面板重新整理後自己看得到;還在衝突中就用 `showWarning` 說「工具已結束,但檔案仍有衝突」,不說「工具關了」:會 fork 的 GUI 工具立刻就返回,終端機工具(只設了 `merge.tool=vimdiff` 這類)在沒有終端機時直接失敗,這兩種情況工具可能還開著,而 git 已經從備份還原了檔案、刪掉 LOCAL / REMOTE / BASE,之後在工具裡存的內容不會被 stage。所以訊息接著說:工具還開著就在那裡存檔再標記為已解決;終端機工具請改設 `merge.guitool`。
- **工具開著的期間不靜音 watcher,只有事後的那次讀取包在 `runRepoMutation` 裡(之後 refresh)。** 那是使用者的工作階段,可能好幾分鐘;watcher 的靜音是旗標(`repoMutation.ts`),整段靜音等於這幾分鐘裡外部的變更都看不到。
- **一個 graph instance 同時只開一個 merge tool;關掉 Tab 不會殺掉它。** 兩個工具各自在結束時 `git add`,會搶同一個 index。殺掉工具會丟掉使用者合到一半的內容,所以 Tab 關掉後它照樣開著,只是結果沒有人回報。`mergetool.keepBackup` 留下的 `.orig` 照使用者的 git 設定,GING 不覆寫。
- **標記為已解決(stage 一個衝突檔)時,檔案裡還有衝突標記就先用 `Prompts.choose` 問。** 標記是行首的 `<<<<<<<`、`|||||||`(diff3)、`>>>>>>>`(core 的 `filesWithConflictMarkers`);單獨一行 `=======` 不算,它也是 Markdown 與 reStructuredText 的標題底線。面板的「標記為已解決」與圖形衝突橫幅的 Mark Resolved 都問:橫幅那一個是圖形的 `markResolved` 請求,桌面版的 graph instance 在 channel 上先問,使用者答應才交給 dispatch,取消就回圖形一則 `markResolved`(status `null`),dispatch 聽不到。VS Code 的 Mark Resolved 照舊不問,它的外部行為不變。

## 補記(2026-11-17,#404)

**桌面版 `Opener` 的 `openCommitDiff` 與 `diffWithWorking` 不再是 stub:兩者都開在該實例的 Tab 頁面裡、蓋在圖形上的 diff viewer(畫面與 Monaco 的注入見 ADR-0031 的同日補記)。** #391 補記的四個 stub 只剩 `openFileAtRevision`(#405):`openMergeEditor` 由 #410 取代。port 本身沒有改,VS Code 的實作也沒有改。

- **兩邊的文字由 main process 讀,依 `defaultFileEncoding` 解碼,讀的地方在 core 的 [fileContents.ts](../../packages/core/src/extension/fileContents.ts)(`readFileAtRevision`、`readWorkingFile`),不是在 `apps/desktop` 那條 lint override 加白名單。** #386 補記把這個選擇留給第一個要讀某版本檔案的桌面呼叫端。選 core:白名單是 VS Code 的 `DiffDocProvider` 為了「依 workspace folder scope 解析 `fileEncoding`」才有的豁免,桌面版沒有這個理由;而「讀 working tree 的檔案並照設定解碼」也是 core 該有一份的事,#405、#406、#408 都會再用到。解碼抽成 `decodeFileBytes`,`getCommitFileContent` 照舊用它,VS Code 的行為不變。
- **working tree 那一側也照 `defaultFileEncoding` 解碼。** VS Code 的 `diffWithWorking` 右邊是真正的檔案,由 VS Code 用它自己的 `files.encoding` 讀;桌面版沒有那個設定,而這個設定的說明寫的正是「diff 檢視裡顯示的檔案內容」,兩側用同一個編碼,diff 才不會因為兩邊解法不同而整行標成改變。working tree 裡已經沒有那個檔案時讀成空的,跟 revision 那一側沒有那個檔案時一樣:diff 顯示的就是整個被刪掉。
- **`fileEncoding()` 是 `DesktopConfig` 的方法,不是 `HostConfig` 的。** dispatch 不讀它;讀它的是桌面版自己的 diff viewer(與 `gitLabToken` 同一類)。VS Code 的對應是 `Config.fileEncoding(scope)`,依 folder 解析,桌面版只有一層設定檔。
- **`openCommitDiff` 照舊用 core 的 `commitDiffView` 決定兩側與標題**,所以 stash 的 untracked 檔(`^3`)、rename 前的舊路徑、`fromHash`、新增與刪除的標題都與 VS Code 相同;讀不到或頁面已經不在時回答 `false`,圖形照它原本的方式說「無法檢視 diff」。**`diffWithWorking` 只讀該 Tab 的 repository 底下的檔案**,與 `openFile` 同一個 `repoRoot`;這裡只做字面上的比對(不跟連結),因為這條路只是在 app 自己的頁面裡顯示文字,不會執行任何東西。
- **diff 只讀該 Tab 的 repository,只跑 hash、hash 的 parent(`^`、`^N`)或 index(`:0`)這幾種 revision。** 兩項都在 `createShowDiff` 裡檢查,所以 `Opener` 的兩個 diff 與之後的呼叫端(#403、#408)走同一道門:每一側的 `repo` 必須就是 `repoRoot()`,working tree 的檔案必須在它底下;revision 不合就 reject(`openCommitDiff` 回答 `false`)。理由:這些值來自頁面,而 `repo` 是 `git show` 的工作目錄,一個以 `-` 開頭的 revision 會被 git 當成選項(`--output=…` 會寫檔)。之後要 diff `HEAD` 的呼叫端,先把它解成 hash。
- **core 的 `getCommitFileBytes` / `getCommitFileContent` 不跑以 `-` 開頭的 revision,直接回答空的,而不是加 `--end-of-options`。** `--end-of-options` 要 git 2.24 以上;這支 query 也是 VS Code 的 `DiffDocProvider` 在用,加上它,較舊的 git 上每個 diff 都會變空,VS Code 的外部行為就變了。不以 `-` 開頭的參數 git 不會當成選項,所以這道檢查擋下的是同一件事。
- **binary 與過大的檔案不讀成文字。** `readFileAtRevision` / `readWorkingFile` 回答 `FileText`:文字、`binary`(照 git 的判斷,前 8000 bytes 有 NUL)或 `tooLarge`(超過 `FILE_TEXT_LIMIT` = 5 MiB;revision 那一側讀到上限就停掉 git,working tree 那一側先看檔案大小)。diff viewer 因此只送一行說明,不把整個檔案經 IPC 送進頁面。
- **給之後的呼叫端的接縫:`GraphInstance.showDiff`([diffViewer.ts](../../apps/desktop/src/diffViewer.ts) 的 `ShowDiff`)。** 它收標題與左右兩個 `DiffSource` —— 某個 revision 的檔案(`DiffSide`,`commit` 可以是 `:0`,也就是 index),或 working tree 的檔案 —— 讀好、解好碼,送到該 Tab 的頁面。`Opener` 的兩個 diff 都走它;#403 的 working tree 檢視(index ↔ working tree、HEAD ↔ index)與 #408 的檔案歷史也從這裡開 diff,不必再經過 `Opener`,除非那個呼叫端在 dispatch 裡。

## 補記(2026-11-18,#408)

**core 多了檔案歷史:query 在 [fileHistory.ts](../../packages/core/src/backend/queries/fileHistory.ts),命令服務在 [fileHistoryService.ts](../../packages/core/src/extension/fileHistoryService.ts)。port 沒有長:它只讀。** 呼叫端今天只有桌面版的檔案歷史面板(ADR-0031 的同日補記);`apps/desktop` 只 import 命令服務,`.oxlintrc.json` 的規則不必開白名單。

- **讀法是 `git -c core.quotePath=false --literal-pathspecs log --follow --cc --raw --no-abbrev -z <start> -- <path>`,每一筆回答該 commit 當時的路徑。** rename(`R`)或 copy(`C`)的那一筆帶著來源路徑(`oldPath`),之前的每一筆是舊名字;所以點一筆打開的 diff 讀的是那個 commit 真正有的檔案。diff 交給 `commitDiffView`(`fileHistoryDiff`:copy 當成 rename,`oldPath` 在第一個 parent、`path` 在該 commit),標題與 CDV 的 View Diff 相同,再經 `GraphInstance.showDiff`(#404 的 `createShowDiff`,只放行 hash 加 `^`)。submodule 的 entry 沒有 diff。
- **`--follow` 的語意照收,限制也照收,不另外補。** 它只能跟一個路徑;跟的路徑是整次 walk 一個,不是每條分支一個 —— 遇到 rename 之後,之後走到的其他分支也改跟舊名字,那些分支上仍用新名字的改動不會列出來(git 文件說 `--follow` "only for a single file",這就是那個限制)。copy 也會被跟進去:copy 出來的檔案,歷史會接到來源的歷史;來源在 copy 之後的改動不在裡面。真的要每條分支各自跟,得自己逐段重跑 path-limited 的 log 並自己判斷 rename,等於重寫一個 `--follow`;沒有呼叫端需要它。從最後一筆往回接著讀也不行:分叉的歷史裡,走訪順序在它之後的 commit 不一定是它的祖先。
- **merge 只在它自己改了檔案時才列:衝突的解法,或 merge 裡另外做的改動。** 這些不在任何別的 commit 裡,不列就從歷史裡消失。`--cc --raw` 列出的是「檔案與每個 parent 都不同」的 merge,兩側各改一處、乾淨合併的 merge 也在內,而那兩處改動已經列在各自的 commit 上。所以 raw 列出的每個 merge 再問一次它的 dense 合併 patch(`git diff-tree --cc -p <merge> -- <path>`,只留不是原封不動取自某一側的 hunk),有剩下東西的才是一筆 entry;只有一側改過的 merge,git 印出 header 但沒有 diff,也不是。merge 的 change 取它對第一個 parent 的那個字母(combined status 的第一個字母):第一個 parent 沒有這個檔案就是 `A`,打開的 diff 左邊不去讀一個不存在的檔案。沒有 `--first-parent`、也不需要 `--full-history`:`--follow` 期間 git 不做 pruning,本來就沒有 history simplification,每條分支上改過它的 commit 都列在它被改的地方。
- **分頁是讀一條串流,不是重跑。** `--follow` 底下 git 把每個走過的 commit 都算進 `--skip`(不論有沒有印出),`--max-count` 卻只算印出的(log.c 對沒印出的 commit 把扣掉的加回去);實測 `--skip=2` 跳過的是兩個不相干的 commit。所以一個歷史只跑一個 `git log`,經 core 新的 `streamGit`([gitSpawn.ts](../../packages/core/src/backend/gitSpawn.ts)):一頁(100 筆,`FILE_HISTORY_PAGE`)讀夠就暫停 stdout,git 寫滿 pipe 之後自己停下來等,下一頁再放開。它不經過 repository 的 simple-git client,所以不占那個 client 的 6 個行程名額;面板開著多久,它就只是一個暫停的行程。**被換掉(開了另一個歷史)、面板關掉、實例處置時殺掉 git**;還在讀的頁回答 `null`,宿主不送。**一頁讀超過 60 秒(`FILE_HISTORY_READ_MS`)殺掉 git、回答原因**(路徑很久以前才被碰過時,git 要走完一大段才湊得滿一頁);**閒置 5 分鐘(`FILE_HISTORY_IDLE_MS`)沒有人要下一頁也殺掉**,之後真的有人要時,重開一個 log 跳過已經給出去的筆數。複審曾提議的「從最後一筆接著讀」在分叉的歷史上不對(見上一條),沒有採用。
- **起點在第一頁解成完整的 hash(`rev-parse --verify <start>^{commit}`),之後每一頁都從它讀**,HEAD 在翻頁之間動了也不會錯位。`start` 是 null 時從 HEAD;HEAD 還沒有 commit 時是空的歷史,不是錯誤。頁面給的 `start` 只能是 hash(4–64 位十六進位),路徑不能是空的或含 NUL;不合的不跑任何 git,直接回答原因。路徑永遠在 `--` 之後,且有 `--literal-pathspecs`,所以 `*`、`[ab]`、開頭的 `:` 或 `-`、換行都只是檔名(vitest 逐一驗)。
- **應用程式選單的 File History…(`ging.fileHistory`,Repository 選單,只在焦點是 `graph` 時 enabled)用系統的開檔對話框挑檔案**,經 `NativeDialogs.showOpenDialog`(ADR-0032 的 seam),預設開在該 Tab 的 repository。挑到的檔案與 repository 兩邊都先 `realpath` 再比:經 junction、symlink 或 `subst` 開的 repository 認得出是同一個資料夾,repository 裡指向外面的連結算外面;最上層叫 `..foo` 的檔案算裡面。外面的用 `Prompts.showError` 說,不讀;git 沒有追蹤的(`ls-files --error-unmatch` 失敗:未追蹤或已忽略)用 `Prompts.showInformation` 說它沒有歷史,而不是開一個空清單讓人以為從沒改過。「問使用者要一個檔案」今天只有桌面版要,照「先有呼叫端」不開在 `Prompts` 上,和 #394 的資料夾同一個做法。
