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

## 補記(2026-11-17,#393)

**每個 Tab 是一個 `WebContentsView`,Playwright 把它們連同視窗自己的頁面都當成 app 的一個 page,出現的順序不固定，所以 `firstWindow()` 不再等於「圖形」。** E2E 依 URL 分辨([tabPages.ts](../../apps/desktop/e2e/tabPages.ts)):`ging://app/` 是視窗自己的頁面(分頁列與 Welcome page),`ging://app/tab?id=N` 是 Tab N 的頁面;聚焦的是哪一個 Tab,讀分頁列上 `.tab.focused` 的 `data-tab-id`。URL 與分頁列都是產品本來就有的東西，照「只讀產品本來就有的東西」不另開出口。既有的 E2E(graph、prompts、settings、window)都改用這組 helper。

- **「其他 Tab 不在畫面上」讀 `BrowserWindow.contentView.children`,不讀 `document.visibilityState`。** main process 把沒聚焦的 Tab 的 view 從視窗拿下來(不只是隱藏),不在任何視窗裡的 view 不會被繪製;但實測在 Playwright 驅動下，被拿下來的 view 的 page 仍回答 `visible`,這個值在 E2E 裡看不出差別,所以 E2E 讀的是哪些 view 在視窗裡、擺在哪裡。
- **兩個 Tab 同時需要認證的 fetch,用兩個只回 401 的本機 server。** 兩個 port 不同，askpass 的提示(`GING: http://127.0.0.1:<port>`)因此分得出是誰的;server 記下每次請求帶來的帳密，證明每個 Tab 頁面上的回答回到的是自己那個 Tab 的 git。fetch 從選單的 `ging.fetchRemote` 觸發，同時驗證「選單命令送到目前聚焦的 Tab」。認證失敗的錯誤框經 `NativeDialogs` 由測試代答。
- **測試結束時先關 server 的所有連線，再關 app。** 一個還在等提示的 git 會把連線開著;不先切斷，它不會結束,Windows 上暫存目錄也刪不掉。
