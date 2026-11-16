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
- **測試收尾時 `server.closeAllConnections()` 是繞道，不是預期行為。** 關掉 Tab 或結束 app 時，正在跑的 git 不會被終止([#450](https://github.com/0Miles/vscode-ging-git-view/issues/450)):git 卡在提示時拿到「取消」會自己結束，但測試若在 git 還連著 server 時失敗，那個 git 會一直留著,server 關不掉、Windows 上暫存目錄也刪不掉。#450 修好之後拿掉這個繞道。
