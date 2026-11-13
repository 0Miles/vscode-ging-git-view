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
