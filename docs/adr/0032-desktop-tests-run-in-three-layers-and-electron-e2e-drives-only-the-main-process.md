---
status: accepted
---

# 桌面版的測試分三層,Electron E2E 用 Playwright 只驅動未打包建置的 main process

GING 有了第二個宿主([#291](https://github.com/0Miles/vscode-ging-git-view/issues/291)),之後每個功能都要考慮兩邊。為了不讓每張票各自發明測法,測試分成三層,每一層只管它最便宜能證明的事:

- **vitest**:core 的 git 邏輯(真的 git、加上 bare repo);port 契約測試,同一份測試同時對 `fakeHost` 與桌面實作跑(Storage、Watcher、RepoSource、Clipboard,#387);桌面版裡不碰 Electron 的純邏輯,例如啟動參數的過濾(`apps/desktop/src/launchArgs.ts`)、主題變數、選單 template 與 accelerator。
- **webview E2E**:`scripts/webview-harness.js` 加上 Playwright 的 Chromium(#389)。管的是 webview 在真的瀏覽器裡的版面與互動,host 是手寫的假 host。
- **Electron E2E**:Playwright 的 `_electron`,只跑**未打包**的建置(`apps/desktop/out/`),只管 **main process 的整合路徑** —— 視窗開得起來、preload 接得上、single-instance 轉得過去、askpass 與 interactive rebase 真的經過 Electron 跑完(#392)。測試在 `apps/desktop/e2e/`,CI 的 `desktop-e2e` job 在 ubuntu 上用 `xvfb-run` 跑,每個 PR 都跑。

三層都不做像素截圖比對。

## 為什麼未來的讀者會困惑

- **Electron E2E 用的是 Playwright,可是它的 Electron 支援還標著 experimental。** 選它的理由:webview E2E 本來就用 Playwright,兩層共用一個依賴、一套 API;`electronApp.evaluate` 能直接在 main process 裡拿到 `app`、`Menu`、`nativeTheme`,選單項用 `Menu.getApplicationMenu().getMenuItemById(id).click()` 就能觸發並讀到 `enabled`。#383 的 smoke 在 Windows 上五項全過(開出視窗、`ELECTRON_RUN_AS_NODE` 跑 helper、選單、single-instance、隔離 credential helper)。退路是 `@wdio/electron-service`,換掉時受影響的只有用 `_electron` 的票:#386、#388、#391、#392。
- **E2E 只讀產品本來就有的東西,不在產品裡埋測試用的全域。** 頁面讀 DOM;main process 用 `electronApp.evaluate` 讀 Electron 自己的 API,用 main process 的 log(stdout / stderr)讀它決定了什麼。例如 single-instance 的 E2E 是看第一個行程 log 出 `launch: repository …` 與 `launch: ignored arguments …`。測試要看的東西產品沒有輸出時,先問的是「使用者或維護者是不是也該看得到它」,而不是加一個只給測試用的出口。
- **每次啟動都帶自己的 `--user-data-dir`。** single-instance lock 的範圍就是 user data 目錄,所以測試不會撞上開發者自己開著的 GING,兩條測試之間也不會互相搶 lock。之後碰到 git 的 E2E 再加上 credential 的隔離:`GIT_CONFIG_NOSYSTEM=1`,`HOME` / `USERPROFILE` 指到暫存目錄,`GIT_CONFIG_GLOBAL` 指到暫存的空檔(#383 實測後 `credential.helper` 為空)。產品本身不覆蓋使用者的 git 設定,這只發生在測試的 fixture 裡。
- **原生對話框一律經過可注入的 seam。** Playwright 和 WDIO 都點不到 OS 的原生對話框,所以 `dialog.showSaveDialog` 這類呼叫在 main process 裡透過一個可替換的函式取得,E2E 換成直接回答的版本。
- **網路只用本機。** 成功的 fetch / push 用 `file://` 的 bare repo;認證用一個只回 401 的本機 server。實測 git 遇到一次 401 會依序呼叫 askpass 兩次(Username、Password),這就足以走完 askpass 的整條路徑,不需要真的帳號。
- **`--no-sandbox` 只出現在測試。** Playwright 1.59 起在 Linux 啟動 Electron 時會自己加;E2E 自己 spawn 的第二個行程在 Linux 上也照加(`e2e/window.spec.ts`)。CI 會印出 `sysctl kernel.apparmor_restrict_unprivileged_userns`:Ubuntu 用 AppArmor 限制非特權 user namespace,Chromium 的 sandbox 哪天起不來時,先看這個值。
- **accelerator 不用 E2E 測。** 送按鍵給原生選單在三個平台的行為都不同,而真正會壞的是 template 寫錯,所以改用 vitest 驗選單 template。
- **不用 `recordVideo`,除錯用 trace。** 錄影要多下載一份 ffmpeg,trace 已經有每一步的 DOM 快照。
- **Windows 的 E2E 延到階段 E。** CI 上 Windows 只跑 vitest(`windows-tests` job)。E2E 在本機 Windows 跑得起來,#386 就是在 Windows 上先跑綠再上 CI 的。
- **測的是未打包的建置,所以 E2E 綠燈不證明安裝包可用。** 未打包時 `process.execPath` 是 `node_modules` 裡的 Electron,打包後是 app 本身;askpass 與 sequence editor 的 helper 打包時還要 asarUnpack。安裝包的 smoke 是階段 E 的事,至少要跑 askpass 與 interactive rebase。
- **這一層依賴兩個 Electron fuse,而 Electron Forge 的 template 預設把兩個都關掉**;用 Forge 就必須覆寫,寫在這裡給階段 E:
  - **`RunAsNode`**:`askpassManager.ts` 與 `sequenceEditorManager.ts` 用 `ELECTRON_RUN_AS_NODE=1` 加 `process.execPath`,把 helper 當成 Node 程式執行。關掉它,兩個 helper 都會壞 —— git 會把 app 本身當成第二個行程啟動,帶著 helper 的路徑與 `Username for '…'` 這種參數。啟動參數的過濾(只接受 `--repo <path>` 或一個位置參數)就是為了讓這種啟動什麼都不開。
  - **`EnableNodeCliInspectArguments`**:Playwright 和 WDIO 都靠 `--inspect` 連上 main process。關掉它,安裝包就沒辦法做自動化測試。

## 考慮過但否決的方案

- **一開始就用 `@wdio/electron-service`。** 它對 Electron 的支援不是 experimental,但 webview E2E 已經選了 Playwright,兩套工具要各自維護設定、各自學一次;#383 的 smoke 也證明 Playwright 夠用。真的換時影響範圍是上面那四張票。
- **像素截圖比對。** 字型、抗鋸齒在 CI 與開發機上都不同,門檻調鬆就抓不到東西、調緊就天天紅。版面要驗的部分由 webview E2E 讀計算後的樣式與位置。
- **E2E 測打包後的安裝包。** 打包流程在階段 E 才存在;現在測只能測一個沒有人會發佈的半成品。
- **在 main process 裡掛測試用的全域,讓 E2E 讀內部狀態。** 例如 #383 的 smoke 用過的 `globalThis.smoke`。它讓測試耦合到實作細節,而且會跟著出貨。見上面「只讀產品本來就有的東西」。

## 後果

- 新的桌面功能:能不靠 Electron 測的邏輯抽成純模組,用 vitest 測;只有 main process 的整合路徑才加 Electron E2E。
- Electron E2E 跑之前要先 `pnpm run compile:desktop`;`pnpm run test:e2e:desktop` 跑的是 `apps/desktop/out/` 裡已經建好的東西。
- 要換掉 Playwright 的 `_electron` 時,改的是 `apps/desktop/e2e/` 與 #388、#391、#392 各自的 E2E,vitest 與 webview E2E 不受影響。
- 階段 E 選打包工具時,`RunAsNode` 與 `EnableNodeCliInspectArguments` 兩個 fuse 是硬約束,見上。

## 補記(2026-11-13,#388)

**啟動時就決定的事,E2E 讀 log 檔,不讀 stdout。** `_electron.launch` 拿到行程之前,main process 已經寫完啟動那幾行(例如 `launch: opening …`、`launch: cannot open …`),之後才掛上的 stdout listener 讀不到。log 檔(`userData/logs/main.log`)本來就是產品的一部分(`HostLogger.reveal` 打開的就是它),所以照「只讀產品本來就有的東西」,改讀它。之後才發生的事(single-instance 轉來的參數)讀 stdout 一樣可行。

- **fixture repo 由測試自己 `git init`。** [fixtureRepo.ts](../../apps/desktop/e2e/fixtureRepo.ts) 在暫存目錄建一個 commit 日期固定的 repo,fixture 的 git 與 app 的 git 都跑在上面說的隔離設定裡(`GIT_CONFIG_NOSYSTEM=1`,`HOME` / `USERPROFILE` 指到暫存目錄)。
- **E2E 一律帶 `--lang=en-US`。** 斷言讀的是頁面上的英文字串;不帶的話,`app.getLocale()` 跟著開發機走,在中文的 Windows 上讀到的是 zh-tw。

## 補記(2026-11-17,#390)

**應用程式選單是 E2E 觸發 core 命令服務的入口,template 是純資料模組。** #390 的 Electron E2E 要走完「core 命令服務的 `Prompts.pick`」整條路徑,而 desktop 上 core 命令服務唯一的入口是選單(#396)。照「只讀產品本來就有的東西」,不在 main process 掛一個測試用的出口,所以先做出選單的一項「Fetch 特定 remote」([appMenu.ts](../../apps/desktop/src/appMenu.ts)),E2E 用 `Menu.getApplicationMenu().getMenuItemById("ging.fetchRemote").click()` 觸發。

- **template 是純資料,哪一項 enabled 也由它決定。** `appMenuTemplate(l10n, commands, platform, { hasGraph })` 不碰 Electron;main process 在顯示的內容改變時用它重建整個選單,自己不改任何一項的 `enabled`。所以 accelerator 與 enabled 規則都由 vitest 驗([appMenu.test.ts](../../apps/desktop/tests/appMenu.test.ts)),E2E 另外斷言 `enabled`,因為直接 `click()` 不檢查它。
- **Electron 原本的 File、Edit、View、Window 選單用 role 保留。** 自訂選單會取代預設選單;不保留的話,複製貼上與重新載入的快捷鍵會一起消失。
- 其餘的命令、「目前聚焦的分頁」的判斷,由 #396 接手同一個 template。

## 補記(2026-11-17,#397)

**設定頁的入口是選單的「設定…」(id `ging.settings`,accelerator `CmdOrCtrl+,`),E2E 照 #390 的做法用 `getMenuItemById("ging.settings").click()` 開它。** accelerator 與「有沒有圖形都能按」由 [appMenu.test.ts](../../apps/desktop/tests/appMenu.test.ts) 驗。為了放這一項,File 選單從 `fileMenu` role 改成照 role 的內容寫出來(macOS 是 Close Window,其他平台是 Quit),上一則補記「File 用 role 保留」的用意 —— 預設選單的快捷鍵不消失 —— 不變。

- **「設定改了立即生效」用一個本機的 bare remote 觀察。** [fixtureRepo.ts](../../apps/desktop/e2e/fixtureRepo.ts) 的 `addAheadRemote` 把 fixture repo 複製成 bare、設為 `origin`,再直接在 bare 裡做一個 commit,讓它比 fixture 的 `refs/remotes/origin/main` 多一個。從設定頁打開 auto-fetch、間隔設成最小的一分鐘之後,不重開 app,在一分多鐘內看到那個 ref 變成新的 commit。這條測試因此至少要一分鐘,`test.setTimeout` 是照設定的下限給的,不是為了讓它變綠而放寬。
- **主題保留的斷言讀 `nativeTheme.themeSource`,不只讀頁面的顏色。** 系統本來就是淺色時,「重啟後是淺色」不能證明選擇被保存;`themeSource` 是 `light` 而不是 `system`,才能。

## 補記(2026-11-17,#391)

**「巡過所有動作」的 E2E 從頁面送出 dispatch 處理的每一種 message,而不是點遍整個 UI。**[actions.spec.ts](../../apps/desktop/e2e/actions.spec.ts) 在頁面裡呼叫 `acquireVsCodeApi().postMessage`,與 webview 自己送出的路徑相同,一種接一種送出,每一種都等到它的回答(或它在 app 外做的事)才送下一種。驗的是 main process 的整合路徑:dispatch、ports、git 都是真的。

- **「每一種」由型別強制。** `EVERY_COMMAND` 是 `Record<Exclude<RequestMessage["command"], "reportError">, true>`,`RequestMessage` 多一種 command 就編譯失敗;跑完再比對實際送出的集合與它相等。`reportError` 不送:它就是 webview 在回報失敗,而這條測試的結論是沒有失敗。
- **「不丟例外、`reportError` 為零次」讀 log。** handler 丟出的例外由 main process 記成 `ERROR:`(`channelTo`),webview 的回報也記成 `ERROR: webview …`,所以關掉 app 之後 log 裡沒有任何 `ERROR:`,兩件事都成立。沒有回答的 command 在 app 關掉之前一定已經跑完:頁面的訊息依序到達 dispatch,而那些 handler 不等任何東西。
- **app 外的副作用一律在 main process 裡替換掉,與替換 `dialog.showMessageBox` 同一個做法。** 產品端呼叫時才去查:`NativeDialogs` 查 `dialog`,桌面版 `OsShell` 查 `shell.openPath` / `showItemInFolder` / `openExternal`,`Clipboard` 查 `clipboard.writeText`,終端機查 `child_process.spawn`。E2E 用 `electronApp.evaluate` 換掉它們並記下被叫了什麼;`child_process` 經由 `process.mainModule.require` 取得,只攔 `detached` 的 spawn(app 只有開終端機時這樣 spawn),git 的照常執行。所以這條測試不開瀏覽器、不開終端機、不碰剪貼簿。
- **網路一樣只用本機。** `origin` 是本機的 bare repo;另外兩個 remote 只為了拼 pull request 的 URL,設了 `remote.<name>.skipFetchAll`,`fetch --all` 不會去連。`fetchAvatar` 回答的是預先放進 user data 的頭像快取,不會去問頭像服務。
- **每個 stub 都斷言「通知出現、沒有錯誤框」**:main process 那一側只出現一個 `info` 對話框(`desktop.notSupportedYet`),頁面上的 `#dialog` 沒有打開。另外有一條從 UI 點進去的:在 Commit Details View 點檔案,走的是 webview 自己送出 `viewDiff` 的路徑。
- **改動 repo 的動作送出後,等圖形自己的重新載入(之後的 `loadCommits` 回答)到了才送下一個;測試自己對 repo 的寫入(stash)全在 app 啟動前做完。** 重新載入會讀 working tree(`git status` 這類命令會短暫拿著 `index.lock`),下一個動作若在那一刻送出,git 會以 `index.lock: File exists` 拒絕。使用者是看到重繪後的圖才會動作,所以這是照使用者的節奏送,不是放寬等待。產品本身的這個競爭(背景重新整理與使用者的動作重疊)記在 #451。batch 動作不等:圖形沒有自己發起的 batch run,不會重新載入。
- **終端機斷言完整的程式與參數,而程式一律是絕對路徑。** Linux 上 app 只在 `PATH` 的絕對路徑資料夾裡找終端機,CI 的機器不一定裝了任何一個,所以 E2E 在暫存資料夾放一個假的 `x-terminal-emulator`、把那個資料夾排到 `PATH` 最前面;它不會被執行(spawn 已被替換),只讓斷言不依賴機器上裝了什麼。
- **walk 也送一個系統會執行的檔案(`run.bat`)給 `openFile`,斷言是 `showItemInFolder` 而不是 `openPath`;送一個 `file:` URL 給 `openExternalUrl`,斷言什麼都沒開。** 另一條測試在圖形頁上 `window.open` 與點一個 `<a>`:web 位址交給瀏覽器替身,頁面還是圖形、視窗還是一個。`file:` 的那幾個多半在 Chromium 就被擋下(非 `file:` 的頁面不能開本機檔案),到不了 app 的 guard,所以只斷言結果,不斷言 log。Playwright 會一直等那個被取消的導覽,所以這條測試事後直接用 `page.evaluate` 讀 DOM,不用 locator。

## 補記(2026-11-17,#393)

**每個 Tab 是一個 `WebContentsView`,Playwright 把它們連同視窗自己的頁面都當成 app 的一個 page,出現的順序不固定，所以 `firstWindow()` 不再等於「圖形」。** E2E 依 URL 分辨([tabPages.ts](../../apps/desktop/e2e/tabPages.ts)):`ging://app/` 是視窗自己的頁面(分頁列與 Welcome page),`ging://app/tab?id=N` 是 Tab N 的頁面;聚焦的是哪一個 Tab,讀分頁列上 `.tab.focused` 的 `data-tab-id`。URL 與分頁列都是產品本來就有的東西，照「只讀產品本來就有的東西」不另開出口。既有的 E2E(graph、prompts、settings、window)都改用這組 helper。

- **「其他 Tab 不在畫面上」讀 `BrowserWindow.contentView.children`,不讀 `document.visibilityState`。** main process 把沒聚焦的 Tab 的 view 從視窗拿下來(不只是隱藏),不在任何視窗裡的 view 不會被繪製;但實測在 Playwright 驅動下，被拿下來的 view 的 page 仍回答 `visible`,這個值在 E2E 裡看不出差別,所以 E2E 讀的是哪些 view 在視窗裡、擺在哪裡。
- **兩個 Tab 同時需要認證的 fetch,用兩個只回 401 的本機 server。** 兩個 port 不同，askpass 的提示(`GING: http://127.0.0.1:<port>`)因此分得出是誰的;server 記下每次請求帶來的帳密，證明每個 Tab 頁面上的回答回到的是自己那個 Tab 的 git。fetch 從選單的 `ging.fetchRemote` 觸發，同時驗證「選單命令送到目前聚焦的 Tab」。認證失敗的錯誤框經 `NativeDialogs` 由測試代答。
- **git 在等提示時關掉 Tab、或結束 app,git 要拿到「取消」並自己結束。** 兩條 E2E 各驗一次：提示還開著時關掉那個 Tab,以及開著兩個 Tab、其中一個在等提示時結束 app;都要 app 照常結束、server 上 git 的連線歸零、log 沒有 `ERROR:`。後者守的是處置順序：視窗關掉之後才處置 Tab,任何一個 Tab 的處置失敗都不能讓後面的 Tab 留著沒處置。
- **~~測試收尾時 `server.closeAllConnections()` 是繞道。~~ [#450](https://github.com/0Miles/vscode-ging-git-view/issues/450) 已修，繞道已拿掉。** 原本關掉 Tab 或結束 app 時，正在跑的 git 不會被終止，測試若在 git 還連著 server 時失敗,server 就關不掉。現在每個 graph instance 持有自己的 `AbortController`,`dispose`(關 Tab;結束 app 時 `will-quit` 處置所有 Tab)時 abort,選單的 fetch、auto-fetch、graph 自己的 Fetch 鈕、分支的 push 與 tag 的 push 經 `spawnGit` 的 `killTree` 送出 kill,目標包括 `git-remote-http`(盡力而為,ADR-0028 的 #450 補記),被中止的 fetch 只寫 log、不跳錯誤框。pull 不會被中止：它的 merge 或 rebase 被殺掉會留下做到一半的狀態，所以卡在 server 上的 pull 在關 Tab 或結束 app 之後仍會留著(ADR-0028 的 #450 補記)。結束 app 時，`will-quit` 會等這些 git(連同它們啟動的行程)都結束才讓 app 離開，最多等 5 秒:Windows 上的 kill 是另外跑的 `taskkill`,app 立刻離開時它會被打斷,git 就留在網路上(實測:不等的話，結束 app 那條 E2E 的連線不會歸零)。server 的 `close()` 不再清場：還有 git 連著，測試就卡在收尾，等於多一道斷言。四條 E2E 用一個永遠不回應的 server 驗證：選單的 fetch 或 graph 的 Fetch 鈕還連著時關掉 Tab、或結束 app,server 的連線都在逾時內歸零;「只收被關那個 Tab 的 git」由 `apps/desktop/tests/graphInstance.test.ts` 證明。

## 補記(2026-11-17,#392)

**askpass 與 interactive rebase 的 E2E 各一條([askpass.spec.ts](../../apps/desktop/e2e/askpass.spec.ts)、[interactiveRebase.spec.ts](../../apps/desktop/e2e/interactiveRebase.spec.ts)),都從圖形自己的按鈕與對話框觸發,斷言只讀頁面、git 與 log。** 兩個 helper 跑不起來時(把 `out/` 裡的 `askpass.sh` 換成 `echo ""`、`sequenceEditor.sh` 換成 `exit 0`)兩條都會紅。

**它們今天還不是 RunAsNode fuse 的偵測器。** 跑的是 `node_modules` 裡未打包、fuse 全開的 Electron,沒有任何建置會把 `RunAsNode` 關掉,所以它們抓得到的是「helper 跑不起來」(檔案沒複製、沒有執行權限、`ELECTRON_RUN_AS_NODE` 沒帶到),抓不到「fuse 被關了」。要等階段 E 把 `executablePath` 換成打包後的 app,它們才會在 fuse 被關掉時變紅;這正是上面「安裝包的 smoke 至少要跑 askpass 與 interactive rebase」的那兩條。

- **401 server 是 [unauthorizedRemote.ts](../../apps/desktop/e2e/unauthorizedRemote.ts)**:Node `http`,綁 127.0.0.1、port 由系統挑,每個請求一律回 401 加 `WWW-Authenticate: Basic`,有沒有帶帳密都一樣,並照到達的順序記下來。`info/refs` 以外的請求(例如 `HEAD /`)也回 401、也記,測試只讀它關心的那幾筆。git 2.40.1 實測:不帶帳密的 `info/refs` 一次,帶帳密的重試一次,然後放棄。重試幾次是 git 的事,沒辦法證明每個版本都一樣(CI 的 ubuntu 上的 git 比開發機新),所以斷言是「至少一次帶帳密的重試,而且每一次都是頁面上輸入的那組」。
- **頁面上看到的是 `askpass.sh` 切開後的 git 提示。** `askpass.sh` 用沒加引號的 `$*` 把 `Username for 'http://127.0.0.1:…': ` 拆成三個參數,`askpassMain` 取第一個字當 `placeholder`(`Username`、`Password`),取引號裡的 URL 組成標題 `GING: <url>`。所以「先問 Username、再問 Password」是讀 overlay 的 placeholder 與標題,第二題的 URL 帶著第一題填的帳號。這是產品現有的行為(沿用 VS Code 的 askpass),本票不改;同一個拆字讓含空白的提示直接失敗,另開 [#445](https://github.com/0Miles/vscode-ging-git-view/issues/445),修正時這條 E2E 的斷言要跟著改。
- **錯誤框是圖形自己的 `#dialog`,不是原生對話框。** 從圖形的 Fetch 按鈕觸發,askpass 的 overlay 正好疊在進度框上(ADR-0031 的 #390 補記),失敗時進度框換成 `Unable to fetch` 的錯誤框。斷言只看標題與有沒有 `.errorReason`,不比對 git 的 stderr 全文。
- **`wasApplied` 不掛測試用的全域來讀,讀它的後果。** rebase 對話框把中間那個 commit 取消勾選,只有 GING 自己寫的 todo 能表達;helper 沒跑的話,git 用自己的 todo 留下每個 commit,`rebaseInteractive` 會因 `wasApplied` 為 false 而失敗。所以「中間那個 commit 不見了、前後兩個照順序留著、沒有錯誤框、log 沒有 `ERROR:`」就是 `wasApplied` 為 true。
- **fixture 的隔離補上 `XDG_CONFIG_HOME` 與 `GIT_CONFIG_GLOBAL`,兩者管的對象不同。** git 的全域設定有兩處:`$HOME/.gitconfig` 與 `$XDG_CONFIG_HOME/git/config`。`isolatedGitEnv` 原本只把 `HOME` / `USERPROFILE` 指到暫存目錄;開發機上設了 `XDG_CONFIG_HOME` 時,git 仍會讀那裡的 `git/config`,裡面若有 credential helper(例如 GCM),它會在 askpass 之前回答,401 就不會走到 askpass(實測可重現)。
  - **app 的 git**:core 的 `gitSpawn.ts` 會把 `GIT_CONFIG_GLOBAL` 等設定覆寫變數從子行程的環境裡拿掉(`STRIPPED_GIT_ENV`),所以 app 的 git 拿到的隔離只有它留下的那些:`GIT_CONFIG_NOSYSTEM=1`、`HOME` / `USERPROFILE`(空的 `.gitconfig`),以及現在指到同一個暫存目錄底下 `.config` 的 `XDG_CONFIG_HOME`(那裡沒有 `git/config`)。
  - **fixture 自己的 git**:另外把 `GIT_CONFIG_GLOBAL` 明確指到那個暫存的空 `.gitconfig`(Windows 上開不了 `/dev/null`,所以用空檔)。app 的 git 看不到這個變數,它只是讓 fixture 這一側不必依賴上面兩處路徑的推導。
- **helper script 在建置時就設成可執行。** `askpass.sh` 等在 repo 裡是 644,git 在 Windows 以外會直接 exec `GIT_ASKPASS`,所以要有執行權限。`AskpassManager` 與 `SequenceEditorManager` 建構時會 chmod,但不等它完成;`apps/desktop/esbuild.js` 複製到 `out/` 時直接 `chmod 755`,CI 的 ubuntu 不必靠那個時間差。
- **rebase 的 fixture repo 自己設 `user.name` / `user.email`(repo 層級)。** fixture 的 git 用 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 環境變數提交,app 的 git 拿不到它們,而隔離後的設定裡沒有任何身分,rebase 重放 commit 時會停在 `unable to auto-detect email address`。

## 補記(2026-11-17,#396)

**應用程式選單長成 desktop 上 core 命令服務的完整入口(不做 command palette)。** [appMenu.ts](../../apps/desktop/src/appMenu.ts) 的 template 仍是純資料:(macOS 才有的)app 選單、File(#394 的三項、設定…、Close / Quit)、Edit、Repository、View、Window、Help。Repository 底下是 Fetch、Fetch 特定 remote、Manage Remotes、Show/Hide Remote Branches、Manage Pull Request Providers、View Reflog、Show Statistics、Set Git User Details、Open in Terminal;Help 底下是 Version Information。

- **四條規則的落點。** 一、每個 GING 自己的項目(含 app / File / Repository / View / Help 這幾個子選單)都有穩定的 `id`,列在 `MENU_IDS`;Electron 的 role 項目與分隔線沒有。二、命令不收 click 傳進來的 window(`MenuItem.click()` 什麼都不傳),而是在被按下的那一刻自己找目標:main process 的 `menuCommands`。三、E2E 用 `getMenuItemById(id).click()` 觸發，旁邊另外讀 `enabled`([appMenu.spec.ts](../../apps/desktop/e2e/appMenu.spec.ts))。四、每個 `id` 的 label key、accelerator、在哪幾種焦點下 enabled,由 [appMenu.test.ts](../../apps/desktop/tests/appMenu.test.ts) 以一張表逐項驗。
- **「目前聚焦的分頁」不經過 `BrowserWindow.getFocusedWindow()`。** 票面的規則(聚焦的視窗 → 最後聚焦的 → Welcome page)寫在 #393 之前，那時假設一個視窗一個圖形。#393 之後 app 只有一個帶分頁的主視窗，設定與統計視窗都不是圖形視窗，所以不論鍵盤在哪個視窗，目標都是主視窗聚焦的 Tab;沒有 Tab 時是 Welcome page。這等於票面規則在單一主視窗下的結果，少了一層會指向設定視窗的查詢。之後若有第二個主視窗，再把「最後聚焦的主視窗」加回這裡。
- **焦點分三種(`MenuFocus`):`graph`、`notice`、`welcome`。** 由聚焦的 Tab 決定(`menuFocus`):有圖形、顯示說明頁(重啟時路徑已不在的 Tab)、或沒有 Tab。enabled 規則:Repository 的圖形項目只在 `graph`;會問問題的 app 層命令(Set Git User Details、Manage Pull Request Providers)在 `graph` 與 `welcome`,`notice` 時關掉 —— 說明頁背後沒有實例，也沒有 host prompt 的 listener,而 Welcome page 被那個 Tab 的 view 蓋住，問在那裡使用者看不到;設定…、Version Information 與 #394 的項目一律可按。Version Information 只用系統對話框，所以 `notice` 時用 Welcome page 那一份命令照樣能回答。
- **沒有 Tab 時，命令問在 Welcome page。** main process 用 Welcome page 的 `Prompts` 建一份 [appCommands.ts](../../apps/desktop/src/appCommands.ts)(current repository 是 `null`,git client 不帶任何實例的 askpass route);有 Tab 時用該 Tab 實例裡同一個工廠建的那一份。Set Git User Details 在沒有存放庫時只剩「全域」可選，這是 core 原本的行為(ADR-0027)。
- **Show Statistics 開在自己的視窗,Open in Terminal 交給聚焦 Tab 實例自己的 `Opener.openTerminal`(#391)。** 統計頁見 ADR-0031 的同日補記。終端機的名稱與圖形工具列的 Terminal 鈕相同(`GING: <資料夾名>`),也同樣只開在該 Tab 的存放庫裡。E2E 照 #391 的做法替換 `child_process.spawn` 裡 detached 的那一次，讀它被要求在哪個資料夾開終端機，不真的開。
- **accelerator 只有兩個:** 設定…的 `CmdOrCtrl+,`(#397),開啟資料夾…的 `CmdOrCtrl+O`。其餘命令沒有,表上明寫「沒有」,誤加一個會讓測試紅。
- **選單不得拿走圖形自己的快捷鍵。** 選單的 accelerator 比頁面先拿到按鍵，所以圖形四個快捷鍵的預設值(`shortcuts.*`:`CTRL/CMD` 加 F、R、H、S;圖形讀 Ctrl 也讀 Cmd,不看 Shift)一個都不能出現在選單上。Electron 的 role 會帶自己的 accelerator,而它們不在 template 的資料裡，所以 appMenu.test.ts 把用到的 role 的預設 accelerator 照 Electron 45 的 `roles.ts` 寫成一張表，三個平台各驗一次;帶 Alt 的組合不算(Alt 在 macOS 會讓頁面讀到另一個字元，在 Windows 是 AltGr)。因此:
  - **View 選單照 `viewMenu` role 的內容寫出來，拿掉 Reload 與 Force Reload**(`CmdOrCtrl+R` 是圖形的 refresh)。重新載入頁面也不是使用者要的「重新整理」;要重新整理按圖形的鈕或 `CmdOrCtrl+R`。
  - **macOS 的 app 選單照 `appMenu` role 寫出來,Hide 換成 GING 自己的項目(`ging.hide`,呼叫 `app.hide()`),沒有 accelerator。** role 的 Hide 帶 Cmd+H,那是 scrollToHead 的預設。讓圖形贏，是因為它是使用者可以改的設定、而且在 VS Code 那邊行為一樣;Hide Others(Cmd+Alt+H)留著。
  - **macOS 的 View 選單不放 Toggle Full Screen**:它的 Control+Command+F 會被圖形當成 Find(圖形讀 Ctrl 也讀 Cmd)。macOS 自己會在選單裡放 Enter Full Screen,視窗的綠色按鈕也照常可用。其他平台的 F11 不衝突，留著。
  - 使用者把某個圖形快捷鍵**改成**選單已經占用的鍵(設定的選項有 A–Z),選單贏。這只發生在使用者自選的鍵上，不改設定的 schema:它是兩個宿主共用的，在 VS Code 那邊這些鍵並沒有被占用。
- **macOS 慣例:** 設定…放在 app 選單(其他平台照舊在 File),Help 選單帶 `role: "help"`,macOS 才把它當成 Help 選單(有搜尋欄)。
- **label 裡的 `&`。** Windows 與 Linux 的原生選單把 `&` 當成 mnemonic 的標記而不顯示，所以 template 在 macOS 以外把 label 裡的 `&` 寫成 `&&`(「Set Git User Name & Email...」、Open Recent 的路徑);macOS 照原樣。

**給 #394 的契約(開啟資料夾、最近使用清單、init)。** id、label 與位置已在 template 裡，#394 只要在 main process 交出 handler:

- `AppMenuCommands.openFolder?()` → `ging.openFolder`,「開啟資料夾...」,`CmdOrCtrl+O`。O 不是任何圖形快捷鍵的預設值，但設定允許使用者把快捷鍵改成 `CTRL/CMD + O`;那時選單贏，理由同上一段的最後一條。
- `AppMenuCommands.openRecent?(repo)` 加上 `AppMenuState.recentRepos`(最近的在前)→ 子選單 `ging.openRecent`,每一項的 id 是 `openRecentId(repo)`(`ging.openRecent:<路徑>`),label 是路徑;清單是空的時子選單在但不能按。
- `AppMenuCommands.initRepository?()` → `ging.initRepository`,「初始化存放庫...」。
- 三個 handler 都是選填:沒給就不出現在選單裡，給了才出現在 File 的最上面，和下面那一組(設定…,macOS 是 Close Window)之間隔一條分隔線。它們一律 enabled;需要別的規則時改 template 與表，不在 main process 改已建好的選單。handler 同樣不收 window,要問就問在 Welcome page 或聚焦的 Tab(`menuCommands` 的 `asking` 是現成的做法)。最近使用清單改變時，main process 要重建選單(`syncMenu`)。

## 補記(2026-11-17,#394)

**資料夾對話框經過同一個 seam:`NativeDialogs` 多了 `showOpenDialog`,E2E 用 `electronApp.evaluate` 換掉 `dialog.showOpenDialog`,直接回答一個路徑。** main process 的 `dialogsFor(owner)` 在呼叫時才去拿 `dialog.showOpenDialog`,所以換掉之後，開啟資料夾與初始化存放庫(Welcome page 的按鈕與選單的 `ging.openFolder`、`ging.initRepository` 都一樣)問到的就是測試的版本;換上的版本同時記下被問的選項，測試因此也驗按鈕文字。`Prompts` 只拿它用得到的 `showMessageBox` 與 `showSaveDialog`,它的測試不必替一個用不到的對話框寫假的。

- **最近使用清單的 E2E 要先關掉所有 Tab 再重啟。** Tab 會在重啟時還原(#393),而 Welcome page 只在沒有 Tab 時看得到;所以「清單在重啟後還在」的做法是開兩個 repo、把 Tab 都關掉、結束 app、刪掉其中一個資料夾、再啟動。清單讀的是頁面上的列，資料夾不在的那一列讀它的「Not found」標記，不讀內部狀態。
- **流程本身(選了資料夾之後做什麼)用 vitest 測。** [repoOpening.ts](../../apps/desktop/src/repoOpening.ts) 把對話框、資料夾檢查、core 的 init 與開 Tab 都當成注入的函式，[repoOpening.test.ts](../../apps/desktop/tests/repoOpening.test.ts) 逐一驗取消、不是存放庫時提議初始化、清單上的資料夾已經不是存放庫時不改開它外層的存放庫;E2E 只走一次整條路徑。

- **選單的三項照 #396 的契約接上。** main process 的 `menuCommands` 交出 `openFolder`、`openRecent`、`initRepository`,`recentRepos` 是 Welcome page 同一份清單的路徑(最多 20 個);開成 Tab 與 known set 改變之後重建選單。資料夾問在系統對話框，所以三項不論有沒有 Tab 都不需要頁面。[welcome.spec.ts](../../apps/desktop/e2e/welcome.spec.ts) 用 `getMenuItemById` 觸發：有 Tab 時的開啟資料夾與初始化，以及 Open Recent 的順序與點下去聚焦既有的 Tab。

## 補記(2026-11-17,#395)

**clone 的 Electron E2E 三條([clone.spec.ts](../../apps/desktop/e2e/clone.spec.ts)),網路照舊只用本機:`file://` bare repo、#392 的 401 server,以及一個新的、永遠不回應的本機 HTTP server([stallingRemote.ts](../../apps/desktop/e2e/stallingRemote.ts))。**

- **URL 在 Welcome page 的 host prompt overlay 裡打,資料夾經 `NativeDialogs` 的 `showOpenDialog` 代答**(#394 的做法)。成功的那條讀分頁列、Tab 頁面上的 commit 數、Open Recent 的第一項與 log。
- **認證那條驗的是「問在 Welcome page」。** 沒有 Tab 可以問,所以 askpass 的 Username / Password 出現在視窗自己的頁面上,蓋在 clone 面板之上;失敗的錯誤框是原生對話框(`Prompts.showError`),由測試代答並讀它的標題。server 記下的帳密證明回答回到了這一次 clone 的 git。目的地不留。
- **取消那條的證據是「server 上的連線歸零」。** 永遠不回應的 server 讓 git 停在第一個請求上,clone 只能被取消;server 數著開著的連線,git 與它的每個行程(`git-remote-http`)都結束了才會是零(ADR-0028 的同日補記)。另外斷言目的地被刪掉、沒有 Tab、log 有 `clone: cancelled`。收尾的 `closeAllConnections()` 只是清場,斷言在它之前。
- **選單項 `ging.cloneRepository`,照 #396 補記的契約新增**(那份契約沒有替 clone 保留 id):`AppMenuCommands.cloneRepository?()`,「Clone Repository...」,沒有 accelerator,位置在 Open Recent 與 Initialize Repository 之間。**只在焦點是 `welcome`、而且沒有 clone 正在問或在跑時 enabled**:進度與帳密都畫在 Welcome page,有 Tab 時被蓋住(票面「clone 發生在還沒有分頁的時候」)。規則在 template([appMenu.ts](../../apps/desktop/src/appMenu.ts) 的 `AppMenuState.cloning`),由 appMenu.test.ts 的表驗;E2E 讀 `enabled` 而不只是 `click()`。clone 正在問或在跑時,會開 Tab 的其他入口也關掉:選單的 Open Folder、Open Recent、Initialize Repository 不能按(同一張表驗),Welcome page 被面板蓋住(`inert`),第二次啟動經 single-instance 轉來的路徑排隊,等 clone 結束才開 —— 否則新開的 Tab 會蓋住面板與帳密提示,git 就卡在一個沒人看得到的提示上。有 Tab 時也能 clone,另開 [#461](https://github.com/0Miles/vscode-ging-git-view/issues/461)。
- **流程本身用 vitest 測**([repoCloning.test.ts](../../apps/desktop/tests/repoCloning.test.ts)):URL 與資料夾的取消、目的地的組法、askpass route 的生命週期、進度的節流、取消、一次一個、視窗關掉時中止且不開 Tab。

## 補記(2026-11-17,#404)

**diff viewer 的 Electron E2E([diffViewer.spec.ts](../../apps/desktop/e2e/diffViewer.spec.ts))驗的是只有真的 app 才證明得了的事:Monaco 的 bundle、worker 與字型都從 `ging://app/` 載入,在頁面的 CSP 之下,沒有任何東西來自別處;兩側的文字由 main process 依 `defaultFileEncoding` 讀好。** 面板本身的行為(切換、Escape、焦點、記住的版面)在 jsdom 用假的 editors 驗([desktopDiffPanel.test.ts](../../packages/webview/tests/desktopDiffPanel.test.ts)),不必每次開 Electron。

- **讀的是產品本來就有的東西:Monaco 自己的 DOM 與瀏覽器的 API。** 左右兩邊顯示的文字讀 `.editor.original` / `.editor.modified` 底下 `.lines-content > .view-lines`(只取該側自己的行;inline 時另一側被刪掉的行畫在 view zone 裡,也叫 `.view-lines`);diff 有沒有算出來看 `.line-insert`;inline 與 side-by-side 看 diff editor 根元素的 `side-by-side` class,以及被刪掉的行是否出現在右側的 view zone。
- **worker 真的是 worker:`page.workers()` 必須正好是 `ging://app/editor.worker.js`。** Monaco 建不起 worker 時會退回在頁面裡算 diff,只在 console 留一個警告,畫面一樣正確,所以只看畫面證明不了 worker 載得進來。字型用 `document.fonts.load("16px codicon")` 之後讀 `FontFace.status`;拿掉 CSP 的 `font-src 'self'`,這一步就以 network error 失敗(已實測)。拿掉 `worker-src 'self'` 則不會紅:沒寫時它退回 `script-src 'self'`,見 ADR-0031 的同日補記。
- **頁面的 console 不得有任何 error。** CSP 擋下的載入會以 console error 出現,所以這一條同時守住「沒有東西從別處載入」。
- **頁面的第一個 diff 有自己的時間預算 `FIRST_DIFF_BUDGET`(30 秒,[diffViewerPage.ts](../../apps/desktop/e2e/diffViewerPage.ts)),之後的 diff 沒有。** 第一個 diff 要先載入約 3.4 MB 的 `monaco.js`,parse 時整個頁面卡住,測試對頁面的每一次讀取(包括 walk 讀宿主回答的 `page.evaluate`)都跟著等。重現過:在壓縮前的 commit(a01f92b,`monaco.js` 7.7 MB)把 renderer 的 CPU 降速 6 倍跑 walk,`viewDiffWithWorking` 的回答等不到 5 秒的預設時間就失敗;壓縮後(1ea0781)在同樣的降速下照樣失敗,所以壓縮只是讓它少見,不是修好;4 倍降速兩者都過;改成下面的等法之後,6 倍降速也過。所以等待改成讀產品本身的狀態 —— 面板在 editor 做好之前標 `aria-busy`(ADR-0031 的同日補記),`diffShown` 等它消失 —— 並給這一次明說的預算;walk 的 `Step.budget` 只用在它的第一個 diff。這是頁面在慢機器上第一次 diff 真的要花的時間,不是放寬等待去蓋過一個 bug。
- **E2E 的結果放在 `apps/desktop/e2e-results/`,不在 `out/` 底下,失敗的測試留下 trace。** `compile` 會先清空 `out/`,原本的 `out/e2e-results` 跟著消失,失敗的那一輪就什麼都查不到(#404 的第一次紅燈就是這樣)。這些測試自己啟動 app,Playwright 的 `use.trace` 只管它自己 fixture 開的頁面,所以 `diffViewer.spec.ts` 與 `actions.spec.ts` 啟動後用 `context().tracing` 錄,失敗時存成 `app-trace.zip`(`keepTraceIfFailed`;`trace.zip` 是 Playwright 自己的 test trace,只有測試端的步驟與時間);config 的 `trace: "retain-on-failure"` 留給之後用 fixture 的測試。
- **#391 那條「點 CDV 的檔案只看到尚未支援」的測試移到這裡,改成打開 diff。** walk(`actions.spec.ts`)的 `viewDiff` 與 `viewDiffWithWorking` 改為斷言 diff viewer 出現、app 外面什麼都沒發生、沒有錯誤框,然後把它關掉,不讓它蓋住之後的步驟。

## 補記(2026-11-18,#408)

**檔案歷史的 Electron E2E 兩條([fileHistory.spec.ts](../../apps/desktop/e2e/fileHistory.spec.ts)),fixture 是測試自己建的、有一次 rename 的 repo。** 一條從應用程式選單 `ging.fileHistory` 觸發(先讀 `enabled`,再 `click()`),開檔對話框照 #394 的做法用 `electronApp.evaluate` 換掉 `dialog.showOpenDialog`,同時記下被問的選項(標題、按鈕、預設資料夾、`openFile`);斷言每一筆在 rename 前後的路徑、點 rename 之前的那一筆打開的是舊路徑的 diff(標題與兩側文字讀 Monaco 自己的 DOM,同 #404 的補記),以及側檢視、清單、diff viewer 由左到右相接。另一條從 CDV 檔案列的右鍵選單打開,驗歷史只到那個 commit、焦點在第一筆、Escape 收掉。兩條都斷言 console 沒有 error、log 沒有 `ERROR:`。

`--follow` 的語意(rename、copy、merge、分頁、特殊字元、submodule)在 vitest 用真的 git 驗([packages/core/tests/queries/fileHistory.test.ts](../../packages/core/tests/queries/fileHistory.test.ts)),不在 E2E 重複:E2E 只管 main process 的整合路徑。面板的行為(握手、翻頁、過期的頁、鍵盤)在 jsdom 驗,版面在 webview E2E 驗(ADR-0031 的同日補記)。

## 補記(2026-11-18,#405)

**唯讀檔案的 Electron E2E 在 [fileAtRevision.spec.ts](../../apps/desktop/e2e/fileAtRevision.spec.ts),與 diff 的分開。** 驗的是只有真的 app 才證明得了的事:main process 在 commit 上讀到的文字依 `defaultFileEncoding` 解碼(working tree 已經改過,顯示的仍是 commit 的);面板裡是一個 Monaco editor、不是 diff;它照副檔名著色;打字不改變內容。

- **「照副檔名著色」讀的是 Monaco 自己的 DOM:那一行被畫成好幾個 token(`mtk*` class 不只一種)。** 純文字的 model 整行只有一個 token。Monaco 0.57.0 的 editor 根元素沒有 `data-mode-id`,不能直接讀語言 id。
- **walk(`actions.spec.ts`)的 `viewFileAtRevision` 從 stub 那一段移到兩個 diff 之後**,斷言同 diff:面板出現、app 外面什麼都沒發生、沒有錯誤框,然後關掉。排在後面,頁面的第一個 editor 仍是 `viewDiffWithWorking` 的,`FIRST_DIFF_BUDGET` 留在原處。stub 已經一個都不剩,walk 的 `stub` 與「尚未支援」的通知文字一併移除。

## 補記(2026-11-18,#406、#460)

**hunk stage 的 Electron E2E([hunkStaging.spec.ts](../../apps/desktop/e2e/hunkStaging.spec.ts))兩條:從 working tree 面板打開檔案的 diff、stage 其中一個 hunk、再從 staged 的 diff unstage 它;以及檔案在 diff 顯示之後改過時,hunk 被拒絕。** git 的各種情形(CRLF、`core.autocrlf`、檔尾無換行、編碼、整檔變更、衝突)由 core 的 vitest 用真的 git 驗(`hunk.test.ts`),E2E 只驗只有真的 app 才證明得了的:Monaco 把按鈕畫在 git 的 hunk 上方而且點得到、點下去的 hunk 經 main process 進了 index、面板跟著重讀。

- **讀的是 repo 與畫面。** index 的內容用 `git show :0:<路徑>` 讀;按鈕的位置用它與被改的那一行的 bounding box 比(按鈕在 hunk 第一行上方,hunk 從改動前三行開始)。按鈕點得到這件事本身就是一項斷言:按鈕若放在 view zone 裡,editor 的行會擋住點擊(ADR-0031 的同日補記)。
- **檔案在 app 啟動前就改好,stale 那條只改 working tree 的檔案。** 理由同 `workingTree.spec.ts`:app 讀 repo 時會不時握著 index 的 lock,測試自己寫 index 會跟它搶。改 working tree 的檔案不碰 index。
- **失敗時留下 app 的 log**(`main.log`,與 `app-trace.zip` 放在一起):main process 那一側做了什麼,只有它看得到。

## 補記(2026-11-18,本機 E2E 不占用使用者的畫面)

**Electron E2E 一律經 [launch.ts](../../apps/desktop/e2e/launch.ts) 的 `launchApp` 啟動,它在 app 的 main 之前用 Electron 的 `-r` 載入測試端的 [quietWindows.js](../../apps/desktop/e2e/quietWindows.js):app 開的每個視窗都看不見、不搶鍵盤、不擋滑鼠。** 本機跑 E2E 時,視窗一個個跳出來搶走焦點,使用者沒辦法同時做別的事。產品碼不動,也沒有給測試用的全域(本 ADR 的原則):app 照常 `new BrowserWindow(...)`,拿到的是測試端換過的一個。`GING_E2E_SHOW=1` 時不載入它,視窗照 app 本來的樣子出現,方便看著跑。

- **視窗照樣「顯示」,只是使用者看不到:`showInactive()`、`opacity: 0`、`focusable: false`、`skipTaskbar`、`setIgnoreMouseEvents(true)`,`show()` 一律改成 `showInactive()`,`focus()` / `moveTop()` 不做事。** 不選 `show: false`:沒顯示的視窗 Chromium 不畫,requestAnimationFrame 不跑,`document.visibilityState` 是 `hidden`,而 Monaco 的版面與圖形的繪製都靠這些;這個做法下實測頁面仍是 `visible`、rAF 照跑、`document.hasFocus()` 為真(Playwright 的輸入不經作業系統的焦點)。也不選移到螢幕外:視窗的位置與大小維持 app 要的樣子,讀版面的測試不受影響。
- **關掉 Windows 的遮蔽偵測(`--disable-features=CalculateNativeWinOcclusion`)。** 被其他視窗蓋住的視窗會被 Chromium 當成 hidden 而停止繪製;測試的視窗本來就在使用者的視窗後面。
- **類別名稱必須是 `BrowserWindow`。** Electron 用 `constructor.name` 認自己的視窗(`getAllWindows`、`getFocusedWindow`),子類別換了名字就從這些清單裡消失。`require("electron")` 的 export 是不能重新定義的 getter,所以 app 拿到的是包了一層 Proxy 的模組,只有 `BrowserWindow` 換掉(`Module._load` 攔 `"electron"`)。
- **`-r <檔案>` 會被 app 當成自己的路徑。** app 照 `electron [switches] <app> [args]` 讀命令列(`launchArgs.ts`),第一個不是 switch 的參數就當 app 路徑;所以 quietWindows.js 先把 `-r` 與自己的路徑從 `process.argv` 拿掉,app 讀到的命令列與沒有它時相同。實測沒拿掉時每個 `--repo` 都被當成「忽略的參數」,幾乎全部 E2E 紅。
- **驗證方式:** 跑全部 desktop E2E 時,另一個行程每 200ms 讀一次前景視窗(`GetForegroundWindow`)所屬的行程與執行檔路徑;不顯示的整輪(50/50)這個 worktree 的 electron 從未出現在前景(同一段時間其他 worktree 的 E2E 有);`GING_E2E_SHOW=1` 的整輪,它搶到前景 53 次。Tab 頁面在兩種模式下都是 `visible`、rAF 照跑;從啟動到圖形畫出,實測不顯示 2.0–3.7 秒、顯示 2.0–2.8 秒(各 6 次,機器同時被其他測試佔用)。
- **webview E2E 本來就是 headless**(Playwright 預設,CI 只裝 `chromium --only-shell`),不受影響。**`pnpm run test:ext` 會開一個真的 VS Code 視窗,沒有支援的方式讓它不出現或不搶焦點:** `@vscode/test-electron` 啟動的是打包好的 VS Code,沒有 `-r`、也不讀 `NODE_OPTIONS`,VS Code 的命令列沒有隱藏或最小化視窗的選項。要在本機跑又不被打擾,只能放到另一個虛擬桌面或交給 CI。

## 補記(2026-11-18,#451、#466、#472、#473)

**拿掉 #391、#403 為了避開 `index.lock` 而加的等待:walk 的 `settle`(改動 repo 的動作之後等圖形的重新載入)與 [workingTree.spec.ts](../../apps/desktop/e2e/workingTree.spec.ts) 在 commit 前等圖形的重新載入。** 根因修在產品:GING 自己的讀取不再拿 `index.lock`,所以動作與背景重新載入重疊也不會被拒。

- **產品端的修正(`gitChildEnv` 的 `GIT_OPTIONAL_LOCKS=0`、`NO_INDEX_REFRESH`)與它的代價記在 ADR-0027 的 2026-11-18 補記**,這裡只記測試端。實測沒有它時,一般的 `git status` 即使沒有東西可刷新也會拿 `index.lock`。
- **對 working tree 的 `git diff`(`unmergedFiles`、`getNewPathOfRenamedFile`)另帶 `-c diff.autoRefreshIndex=false`(`NO_INDEX_REFRESH`)。** 實測 git 2.40.1:這種 diff 在 `GIT_OPTIONAL_LOCKS=0` 下仍會刷新並寫回 index。這個設定不放進全域的 `GIT_CONFIG_OVERRIDES`:它會讓不帶 filter 的 diff 也列出只有時間戳改變的檔案,而 `-c` 會傳到寫入命令執行的 hook 裡。
- **vitest 不用「讀寫同時跑、沒有失敗」的壓力測試。** 實測沒有修正時,兩個讀取迴圈加 40 次寫入,只有約 1 次被拒,綠燈證明不了什麼。[indexLock.test.ts](../../packages/core/tests/queries/indexLock.test.ts) 改成監看 `.git` 資料夾,斷言讀取期間沒有出現任何 `.lock` 檔:讀取結束後寫一個哨兵檔,等聽到它,之前的事件就都到了(監看事件依發生順序送達)。對照組是不經 GING 的 client 的 `git status`,在同一個狀態下確實拿了鎖。不帶 `NO_INDEX_REFRESH` 的 diff 在 git 2.40.1(Windows)會拿鎖、拿掉它測試會紅;CI 的 git 2.56.1(ubuntu)在測試的狀態下沒拿,所以 diff 不能當各平台的對照組。
- **改動失敗的原因不再被之後的 refresh 抹掉(#466)。** 面板只在使用者送出下一個改動時清掉改動的錯誤;讀取的回答不覆蓋它,讀取本身失敗才顯示讀取的錯誤,下一次讀取成功時清掉。jsdom 測試照實際順序:先 `refresh`、再失敗的回答、再 refresh 引起的讀取。
- **walk 等每一步回答的期限改成明定的 `ANSWER_BUDGET_MS`(16 秒),不再沿用 Playwright 預設的 5 秒(#472)。** #472 在 Windows 上看到的兩種逾時是兩件事:一是寫入動作(`mergeBranch`)的回答帶著錯誤,符合撞上背景重新載入的 `index.lock`(推論:當時的 log 已不在),由上面的修正處理;二是讀取步驟(`branchCleanupScan`、`branchRedundancy`)的回答超過 5 秒才到。後者不是卡住:`branchCleanupScan` 依序跑約 20 個 git 命令,Windows 上每個 spawn 100–250ms,實測 1.9–5.0 秒(CPU 全滿或與其他測試同時跑),10 次 walk 有 1 次超過 5 秒;`branchRedundancy` 0.9–2.9 秒。期限取最壞值的約四倍,與 #425 依 spawn 數訂期限的做法相同。CI 只在 ubuntu 跑 walk,一直在預設之內,所以沒抓到。 **#475 審查後:** 多出來的成本有一部分不是固有的 —— `scan` 在掃描前後各讀一次 branch facts,而 facts 的合併讀取窗只有 1 秒,掃描一超過就從 git 重讀一次。改成一次讀取供前後兩份 payload 使用(`branchCleanupService.ts`,有 vitest 驗只讀一次)之後重量(Windows、CPU 全滿、3 次 walk):`branchCleanupScan` 2.0–4.1 秒、`branchCleanupOpen` 0.9–2.0 秒、`branchRedundancy` 約 2.0 秒,期限依最壞值約四倍訂為 16 秒。每個 branch 一個依序的 `merge-tree` 留著:它撐起進度與取消。
- **#473 是同一件事。** 它看到的 `an answer to branchCleanupScan`(前一步 `branchCleanupOpen` 也花了 3.6 秒)就是上一條的 (二);另一種 `the graph's reload after checkoutCommit` 是 `settle` 的等待,已整個拿掉。#404 的 `Step.budget` 留著,給比 `ANSWER_BUDGET_MS` 更慢的步驟(第一個 diff 的 `FIRST_DIFF_BUDGET`);沒有 `budget` 的步驟,回答等 `ANSWER_BUDGET_MS`。
- **#407 的 amend E2E 在負載下也撞上同一種 5 秒預設,改用 `AMEND_DRAWN_BUDGET_MS`(20 秒)。** 實測(Windows、CPU 全滿、10 次):按下警告的確認後 1.0–2.9 秒 HEAD 移動,3.8–8.5 秒圖形畫出新的 commit,10 次都有畫出 —— 是重新載入慢,不是重新載入遺失。 #475 審查後再拆:按下確認到畫出之間,頁面只收到一個 `loadCommits` 回答(6 次;畫出在點擊後 1.4–2.4 秒,回答最多早 0.4 秒),沒有重複的重新載入可以合併,時間就是 amend 自己的 git 加一次重新載入。
- **E2E 改動 repo 之前的 fixture 寫入(stash、改檔)仍在 app 啟動前做**,只是不再需要理由:它們是 fixture 的一部分。

## 補記(2026-11-18,#409)

**blame 的 Electron E2E 兩條在 [fileBlame.spec.ts](../../apps/desktop/e2e/fileBlame.spec.ts),fixture 是測試自己建的兩個 commit(Alice 新增、Bob 改第二行)。** 驗的是只有真的 app 才證明得了的事:Monaco 真的把註記畫在每一行前面(讀 `.view-line` 裡的 `.gingBlameAnnotation`;Monaco 把空白畫成 no-break space,讀之前換回來);hover 是宿主寫好的完整內容(commit 訊息的 body、hunk 的 `+SECOND`),Markdown 的 `command:` 連結真的經 main process 打開這一行的 diff;再次打開檔案時切換鈕記得是開的;鍵盤的 Ctrl+K Ctrl+I 顯示游標那一行的完整 hover,Shift+F10 的 Find Commit in Graph(選單第一項,ArrowDown、Enter 選)與點註記都讓面板關掉、圖形停在那個 commit(CDV 打開或焦點在那一列)。「hover 只在宿主寫好完整 Markdown 時才回答、被取代時回答 null」是 provider 層的事,由 vitest [blameHoverRule.test.ts](../../apps/desktop/tests/blameHoverRule.test.ts) 決定性地驗,E2E 不靠延遲去重現它。另一條從應用程式選單的 `ging.blameFile` 觸發(先讀 `enabled`,再 `click()`),開檔對話框照 #394 的做法換掉,斷言它被問的標題與按鈕、標題寫 working tree,以及還沒 commit 的那一行寫「You • Uncommitted changes」。兩條都斷言 console 沒有 error、log 沒有 `ERROR:`。

- **blame 的語意在 vitest 用真的 git 驗,不在 E2E 重複**:某個 commit 的檔案、`^`、rename 前的檔名、shallow clone 的 boundary、非 UTF-8 檔逐行、特殊字元的路徑、`-` 開頭的 revision、大小上限、abort([atRevision.test.ts](../../packages/core/tests/queries/blameFile/atRevision.test.ts));一次一個檔案、被取代或關掉時回答 null、hover 的內容與連結參數的檢查([fileBlameService.test.ts](../../packages/core/tests/extension/fileBlameService.test.ts));宿主端的訊息往返、選單的 Blame File…、未追蹤的檔案([graphInstance.test.ts](../../apps/desktop/tests/graphInstance.test.ts))。面板的切換、記住、取代與關閉時放掉、過期的回答、點擊與連結在 jsdom 用假的 editors 驗([desktopDiffPanel.test.ts](../../packages/webview/tests/desktopDiffPanel.test.ts))。
- **它照「本機 E2E 不占用使用者的畫面」補記,經 `launchApp` 啟動 app。** 沒有改 `actions.spec.ts`。

## 補記(2026-11-18,#401)

**階段 C 的收尾驗收是一條 Electron E2E([phaseC.spec.ts](../../apps/desktop/e2e/phaseC.spec.ts)):一個使用者、一次 app 工作階段，epic #291 C「完成的意思」的每個子句是一個具名的 step。** 各子句自己的 spec 驗得更深，這一條證明它們串得起來;圖形的每一個動作仍由 `actions.spec.ts` 的 walk 驗。

- **需要認證的遠端改成「帳密對了就放行」的本機 server([guardedRemote.ts](../../apps/desktop/e2e/guardedRemote.ts))。** 帳密不對時照 #392 回 401;對了就把請求交給 git 自己的 `git http-backend`(CGI,`REMOTE_USER` 讓 receive-pack 可用),所以 clone、push、fetch 是真的通過認證並完成，不只是「有問」。只綁 127.0.0.1,網路仍只用本機。backend 起不來、讀到一半斷掉(EPIPE)或沒有 CGI 回答時回 502,路徑解不開回 400,server 不會因此掛掉或留著不回應的請求。
- **主程序的替身集中在 [mainProcess.ts](../../apps/desktop/e2e/mainProcess.ts)。** 選單的點擊與 `enabled`、資料夾對話框、訊息框、終端機的替身(`standInTerminals`,可寫進呼叫者自己的清單)與 Linux 上 PATH 裡的假 `x-terminal-emulator`、設定頁的開法，原本各 spec 各一份，改成共用。Linux 上 phaseC 不替換 spawn,PATH 上的假終端機真的被啟動並記下 cwd;Windows 的終端機是 `ComSpec`,不查 PATH,所以 Windows / macOS 用替身。
- **等 git 做完的等待有自己的時間預算 `GIT_WORK`(30 秒),只用在 git 的工作上:clone / push / fetch 完成、askpass 的問題出現(每個問題都要啟動一次 askpass helper,也就是 app 自己的 binary 以 Node 執行)、git 改了存放庫之後圖形的重畫。** Open Folder、init 與 Tab 標題用預設的 5 秒。這照 #404 `FIRST_DIFF_BUDGET` 的前例：等的是產品本身畫出來的狀態，不是放寬等待去蓋過 race。量測：
  - Windows 本機，負載高(CPU 約 85%,同時有其他 E2E):clone 6–11 秒、建 branch 並 push 7–17 秒、fetch 6–10 秒、改設定 4–7 秒;一個 askpass 問題要約 2 秒才出現、建好的 branch 要 4.2 秒才畫出來。預設 5 秒時 10 次裡 4 次紅，每次停在不同的 git 等待,trace 顯示頁面一直有回應;同 #473 對 `actions.spec.ts` 的判斷。
  - CI(ubuntu,PR #478):同樣的步驟 clone 0.9 秒、建 branch 並 push 1.3 秒、fetch 0.7 秒、改設定 1.0 秒。
  - 每個 step 的耗時印在測試輸出(`phaseC step <秒>: <step>`),之後的 run 都能拿來對照。
- **「沒裝 VS Code」在 E2E 裡是啟動 env 的條件:** 拿掉 `VSCODE_*`、`GIT_ASKPASS` / `SSH_ASKPASS`,以及 PATH 上放著 `code` 的資料夾 —— 但同時放著 git 的資料夾留著(例如 VS Code 的套件把 `code` 連到 `/usr/bin`),並斷言 git 仍在 PATH 上。真正乾淨的機器是安裝包的事(階段 E)。
- **有 Tab 時不能 clone(#461)是現況，被斷言並加上 annotation。** walk 因此先 clone;#461 做完時這一行要翻過來。
