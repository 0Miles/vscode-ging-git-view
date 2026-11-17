---
status: accepted
---

# webview 一個宿主一個入口,桌面版專屬的畫面與訊息只從桌面入口進來

webview 原本只有一個入口 `packages/webview/src/main.ts`,而且它是載入就執行的腳本:模組一被求值,就讀 `viewState` 與 `vscode.getState()`、建出圖形、在 `window` 與 `document` 掛上 listener。別的入口 import 它,就等於當場在 import 的那一行啟動了圖形,沒辦法先做自己的事,也沒辦法只拿其中一部分。

#384 把它拆成三個檔案:

- **[gitGraphView.ts](../../packages/webview/src/gitGraphView.ts)**:原本 `main.ts` 的全部內容(用 `git mv` 搬,保留歷史)。import 它不會碰頁面;所有碰頁面的事 —— 武裝 error reporter、找 `#contextMenu` / `#dialog`、建 `GitGraphView`、掛 listener —— 都收進 `startGitGraphView()`,順序與原本載入時一樣。
- **[main.ts](../../packages/webview/src/main.ts)**:VS Code 入口,`apps/vscode/esbuild.js` 打成 `out/web.min.js` 的那一支。內容只剩 import 加上呼叫 `startGitGraphView()`,所以載入就執行、行為不變。拆分前的 116 支 webview 測試檔一行都沒改,其中驅動圖形的那些照舊用 side-effect import 載入 `@ging/webview/main`。
- **[desktop/main.ts](../../packages/webview/src/desktop/main.ts)**:桌面入口,只有 `apps/desktop`(#386)會打包。今天它只做兩件事:在 `<html>` 寫上 `data-ging-entry="ging-desktop-entry"`(標記字串),然後啟動同一個圖形。標記是寫進頁面的,不只是宣告,所以 tree-shaking 拿不掉它。

[webviewEntries.test.ts](../../apps/vscode/tests/backend/webviewEntries.test.ts) 用 production 的 esbuild 選項把兩個入口一起打包,守兩件事。一是邊界本身:從 metafile 讀出每個 bundle 吃進了哪些模組,VS Code 的 bundle 不得有任何 `src/desktop/` 底下的檔案,不管那個檔案帶不帶標記。二是標記:VS Code 的 bundle 裡找不到,桌面的找得到。兩件事都有桌面那一側當對照組 —— 沒有它,讀法壞掉或標記在兩邊都被 tree-shake 掉,VS Code 那一側也會綠。

## 為什麼未來的讀者會困惑

- **桌面版專屬的程式碼靠「入口」分開,不靠 runtime 的宿主旗標。** 看起來 `if (viewState.host === "desktop")` 比較省事。但 esbuild 不知道旗標在 runtime 的值,兩個分支都會打進同一個 bundle:VS Code 的 `.vsix` 會帶著 host prompt overlay、側檢視、working tree、diff viewer 的全部程式碼(以及之後的 Monaco)出貨,而那些程式碼在 VS Code 裡一次都不會跑。分界改由 import 圖決定:`desktop/` 底下的東西只從 `desktop/main.ts` 被 import,VS Code 入口碰不到,上面那支測試守住這件事。旗標也不是 ADR-0027 意義下的宿主能力 —— 它問的是「我是誰」,不是「宿主能不能做某件事」,而後者才是 port 的單位。
- **`gitGraphView.ts` 的模組範圍裡還是有一堆 `let`,而且狀態是整個模組共用一份。** 這不是要讓圖形能在同一頁建兩個。只把「載入時的副作用」搬進 `startGitGraphView()`,宣告與函式都留在原地,是 11000 行的檔案裡改動最小、行為最確定不變的切法;`startGitGraphView()` 的註解寫明一頁只能呼叫一次。把整個檔案包進一個函式也做得到,但每一行都要多縮排一層,`git blame` 從此全部指向這一個 commit,換到的只是「可以呼叫兩次」,而現在沒有任何人要呼叫兩次。
- **import `gitGraphView.ts` 仍然會呼叫 `acquireVsCodeApi()`。** 那一次是在 `./utils/vscode` 被求值時發生的,不在 `startGitGraphView()` 裡。改成延後取用,得動到每一個用 `vscode` 的地方,而桌面版本來就要在 bundle 載入前由 preload 提供 `acquireVsCodeApi`(#386 的範圍寫明了),兩個宿主都滿足這個前提。所以「import 不碰頁面」的保證不包括它,`gitGraphView.ts` 的檔頭註解寫明了這個例外。
- **`HostPromptMessage`(#390)不在 `ResponseMessage` 裡,可是它跟圖形的訊息走同一個 `message` 事件。** `applyResponseMessage` 的 `default` 用 `never` 做窮舉檢查:型別一加進 `ResponseMessage`,VS Code 入口就得替它寫一個分支才編得過,而那個分支要 import 的東西就進了 VS Code 的 bundle。所以桌面專屬的訊息由桌面入口自己的 listener 處理,型別也宣告在 `desktop/` 底下。兩個 listener 都會聽到每一則訊息,這之所以安全,是因為 dispatch 在 runtime 對沒有分支的 command 什麼都不做、也不回報錯誤 —— 這個性質由 [desktopEntry.test.ts](../../packages/webview/tests/desktopEntry.test.ts) 釘住。反過來,桌面的 listener 也必須略過不是它的訊息。
- **Monaco 不由 `packages/webview` import,連依賴都不列。** `packages/webview` 只定義 editor 與 diff viewer 的**工廠介面**,`apps/desktop` 實作(那裡才 import Monaco)後注入桌面入口。只要 `packages/webview` 的 `package.json` 列了 Monaco,VS Code 入口就解析得到它,「Monaco 不進 `.vsix`」就只剩 review 在守;不列的話,照 ADR-0026 的邊界,VS Code 入口一 import 就是 TS2307。介面的形狀與注入點現在**不**先寫:依 ADR-0027「先有呼叫端」,它們隨第一個呼叫端 #404 一起長出來,而 #404 要像本票一樣,確認 Monaco 的標記字串不在 VS Code 的 bundle 裡。
- **桌面外殼的版面骨架在這裡劃好,但沒有任何區域的程式碼。** 區域由各自的票填:側檢視(#399)與 working tree(#403)誰先合併,都不替另一個決定位置、寬度或捲動方式。骨架如下:
  - **圖形區**:頁面本身。圖形量的是 `window` 的捲動(`scrollY`、`innerHeight`、`document.body.offsetHeight` 的接近底部門檻)、frozen header 與 docked Commit Details View 都是 `position: fixed`,所以圖形繼續擁有文件的捲動,不搬進一個會捲動的容器。
  - **側檢視區**(#399):左側、與視窗等高的 `position: fixed` 直欄。它擁有 `body` 的 `padding-left`,用來讓出圖形區的寬度。
  - **working tree 區**(#403):右側、與視窗等高的 `position: fixed` 直欄。它擁有 `body` 的 `padding-right`。
  - **host prompt overlay**(#390):最上層,蓋在 `#dialog`(z-index 401)之上,不取代也不關閉它。
  - diff viewer(#404)不另佔一欄,開在圖形區之上;怎麼開由 #404 決定,但不得改變上面兩欄的位置。
  - 每個區域的元素(連同 id)與樣式由填它的那一張票建立;這裡定的只有哪一側、誰擁有哪一邊的 padding、誰在最上層,其餘依「先有呼叫端」留給那張票。樣式放在只有桌面會載入的樣式表,不放進 `media/main.css` —— 那一份會被複製進 `.vsix`。

## 考慮過但否決的方案

- **runtime 的宿主旗標**(`viewState` 帶一個 host 欄位,或探測 `acquireVsCodeApi` 的來源)。兩個分支都進同一個 bundle,見上。
- **把 `HostPromptMessage` 加進 `ResponseMessage`,VS Code 入口寫一個什麼都不做的分支。** 分支本身很小,但它讓「VS Code 入口認得桌面的訊息」變成協定的一部分;之後每一種桌面專屬的訊息都會照抄一次,而只要有一個分支順手 import 了桌面的模組,桌面程式碼就進了 VS Code 的 bundle,typecheck 不會攔。
- **Monaco 列為 `packages/webview` 的依賴,再用動態 `import()` 延後載入。** VS Code 的 bundle 是 `iife` 單檔,esbuild 不會為它切 chunk,動態 import 的東西一樣被打進去;就算切得出來,依賴也已經對 VS Code 入口可見,見上。
- **趁這次把 `main.ts` 拆成很多個依功能分的模組。** 桌面入口今天需要的只是「可以 import、由自己決定何時啟動」;依功能拆是另一件事,牽動 11000 行之間的互相引用,也會讓這次「VS Code 入口行為不變」的驗收失去焦點。真的需要只拿其中一塊時,再照那個呼叫端拆。
- **圖形搬進一個會捲動的容器,外殼用 CSS grid 排三欄。** 版面最乾淨,但圖形讀的是 `window` 的捲動與尺寸,要全部改成讀容器,改的是兩個宿主共用的程式碼,VS Code 的行為也跟著冒險。用 fixed 直欄加 `body` 的 padding,圖形一行都不用改。

## 後果

- **桌面專屬的畫面、訊息型別與 listener 放在 `packages/webview/src/desktop/` 底下,只從 `desktop/main.ts` 被 import。** VS Code 入口與 `gitGraphView.ts` 都不得 import `desktop/` 底下的東西。`webviewEntries.test.ts` 會在任何 `desktop/` 底下的模組、或標記字串進到 VS Code 的 bundle 時失敗。它看的是 `desktop/` 這個資料夾,所以不在那裡面的大塊依賴(例如 `apps/desktop` 注入的 Monaco,#404)要在同一支測試裡補上自己的檢查。
- **`gitGraphView.ts` 必須維持「import 不碰頁面」。** 新的全域 listener 或任何讀 `viewState`、`l10n`、DOM 的模組層級初始化,一律放進 `startGitGraphView()`。
- **桌面入口今天沒有自己的 listener,也沒有 `HostPromptMessage` 型別。** 它們由 #390 帶著第一個呼叫端加進 `desktop/`。屆時要讓 `HostPromptMessage` 的 command 名稱與 `ResponseMessage` 的不重疊成為型別檢查(例如兩者 `command` 的交集必須是 `never`):共用一個 `message` 事件,command 撞名時圖形的 dispatch 會把桌面的訊息當成自己的。
- **docked Commit Details View 與 `#scrollShadow` 今天橫跨整個視窗寬度(`left: 0; right: 0` / `width: 100%`)。** 側檢視或 working tree 的直欄一出現,它們會疊到直欄上。兩張票各管自己那一側:#399 把它們的左緣讓出側檢視的寬度,#403 把右緣讓出 working tree 的寬度,誰先合併都只動自己那一邊,而且改的是桌面樣式表,不是 `main.css`。

## 補記(2026-11-13,#386)

**桌面入口的頁面從 `ging://app/` 提供,不用 `file://` 或 data URL。** `apps/desktop` 的 main process 把 `ging` 註冊成 standard、secure 的 scheme,`ging://app/` 回答它當場組好的頁面(主題寫在 `<html>` 與 `<body>` 上),其餘路徑只放行打包產物裡的頁面資產(`out/web.js`、它的 source map、`out/main.css`),其他一律 404。

- **要一個真正的 origin。** data URL 的 origin 是 opaque,`localStorage` 這類 storage 用不了,而 #291 打算讓桌面版的 `setState` 落在那裡;`file://` 的 origin 也不屬於這個 app,是所有本機檔案共用的。自訂的 standard scheme 讓頁面有自己的 `ging://app` origin,CSP 也能照 VS Code 那份的意思寫成 `'self'`,不必列出路徑。
- **main process 決定哪些檔案拿得到。** `file://` 會讓頁面能讀整個檔案系統上它猜得到路徑的東西;這裡只有白名單上的幾個檔名,路徑由 main process 自己接到 `out/`。白名單由 `page.ts` 的 `PAGE_ASSETS` 推導,頁面要多載一個檔案,就在那裡加。

## 補記(2026-11-13,#388)

**頁面是哪一種，由宿主寫在 `<html>` 的 `data-ging-page` 上(`graph` 或 `notice`),桌面入口照它決定要不要啟動圖形。** 桌面版沒有 repo 可顯示時 —— 沒帶參數,或 `--repo` 指的不是 Git 存放庫 —— 給的是一頁 `notice`(後者附上說明),它照樣載入桌面入口，因為之後的 Welcome page(#394)也從這裡進來。種類由宿主明說，不由入口從「少了 `viewState`」去推:推出來的版本會把「宿主忘了寫 `viewState` 的圖形頁」當成說明頁，安靜地什麼都不顯示。所以 `graph` 頁上沒有 `viewState`,入口會送出 `reportError`(ADR-0016),而不是空白。

`--repo` 指的不是 Git 存放庫時，說明頁只取代**沒有圖形**的頁面。視窗裡已經開著圖形時 —— 例如第二次啟動經 single-instance 轉來一個無效的路徑 —— 圖形留著，同一段說明改成蓋在上面的錯誤對話框(經過 `NativeDialogs`,見 ADR-0032):一個打錯的路徑，不應該關掉使用者正在用的圖形。判斷寫在 `desktop/` 底下,VS Code 入口不讀這個屬性;[desktopEntryNoGraph.test.ts](../../packages/webview/tests/desktopEntryNoGraph.test.ts) 釘住兩種頁面的行為。

宿主給 webview 的訊息由 preload 以 `window.postMessage` 送進頁面,形狀與 VS Code 的一樣,圖形的 `message` listener 不必知道是哪個宿主。`viewState` 與 `l10n` 跟 VS Code 一樣寫成兩段帶 nonce 的 inline script,CSP 只放行那個 nonce。

## 補記(2026-11-17,#390)

**host prompt overlay 是一個 modal 的 `<dialog>`,放在 top layer,而且是 `<html>` 的子元素,不是 `<body>` 的。**[hostPromptOverlay.ts](../../packages/webview/src/desktop/hostPromptOverlay.ts) 在第一個 prompt 到達時才把它建進頁面。

- **不放在 `<body>` 裡。** `#dialog` 開著時,圖形的 `setBackgroundInert` 會把 `<body>` 的每個子元素標成 `inert`,之後才加進來的也會被 `lateBackgroundObserver` 補標。overlay 若在 `<body>` 裡,askpass 正好在進度框開著時問帳密,問題就畫出來了卻答不了。改 `markInert` 讓它認得 overlay 也做得到,但那是兩個宿主共用的 `gitGraphView.ts` 認得一個桌面專屬的元素,正是這份 ADR 要避免的。`<html>` 底下多一個 `<body>` 以外的元素不合 HTML 的內容模型,但瀏覽器照常繪製,`showModal()` 也照常把它放進 top layer。
- **用 `showModal()`,不自己寫 z-index 與 focus trap。** top layer 本來就在 `#dialog`(z-index 401)之上;modal 讓頁面其餘部分在它開著時全部 inert,`#dialog` 也包括在內,所以不必另寫一套 focus trap。它不碰 `#dialog` 的內容與 class:進度框照常留著,batch run 的 retry offer 不會被寫掉,`showDialog` 的 abandon 判斷也就不會觸發。最後一個 prompt 回答後,焦點回到開啟前持有它的元素;那個元素在 overlay 開著時被圖形換掉了的話,`#dialog` 還開著就回到 `#dialog`。
- **鍵盤事件停在 overlay。** 圖形的 `documentKeydown` 在 `#dialog` 開著時,會把 Enter 當成按下 `#dialogAction`、把 Tab 拉回 `#dialog`;`documentKeyup` 在 Escape 放開時關掉 `#dialog`。overlay 在自己身上 `stopPropagation` 這幾種事件,`document` 上的 listener 就聽不到。Escape 在 keyup 才關掉 prompt,keydown 時 `preventDefault`:瀏覽器內建的「Escape 關閉 modal」發生在 keydown,若讓它關,接下來的 keyup 會落在已經回到 `#dialog` 的焦點上,把 `#dialog` 一起關掉。[hostPrompt.spec.ts](../../e2e/webview/hostPrompt.spec.ts) 在進度框與 retry offer 上各驗一次;拿掉 keydown 或 keyup 的 `stopPropagation`,它就會紅。
- **一次一個,先來先問(FIFO)。** 佇列在頁面上;宿主想問就送,不等上一個回答。兩個 prompt 之間 overlay 不關,焦點不會在兩題之間跳回 `#dialog`。
- **樣式由桌面 bundle 寫進頁面**([hostPromptStyles.ts](../../packages/webview/src/desktop/hostPromptStyles.ts)),不另設一個樣式表檔。「後果」說樣式放在只有桌面會載入的樣式表;一個由桌面入口自己插入的 `<style>` 同樣只有桌面會載入,而且不必替 `PAGE_ASSETS`、`esbuild.js` 與 harness 各加一個檔案。CSP 的 `style-src` 本來就有 `'unsafe-inline'`。overlay 不在 `<body>` 裡,繼承不到 `body` 的字型與顏色,所以樣式自己寫明。

**協定:宿主送 `HostPromptMessage`,頁面回 `HostPromptReply`,型別都在 [hostPrompt.ts](../../packages/webview/src/desktop/hostPrompt.ts)。**

- **`hostPrompt`** 帶一個 id、prompt 本身(pick 的列只有 label、description、picked、warning,沒有 value),以及 OK / Cancel 按鈕的文字。按鈕文字由宿主隨每個 prompt 送來,不放進 `webviewL10n`:overlay 因此不依賴圖形頁的 `l10n` 全域,`webviewL10n` 也不會為了桌面多帶兩個 VS Code 用不到的字串。
- **頁面回答的是索引,不是 value。** value 是任意的 `T`(例如 Manage Remotes 的 `ConfiguredRemote | null`),不一定能過 IPC,也不該交給頁面;宿主保留 value,依索引對回去。pick 回一個索引、pickMany 回索引陣列、choose 回動作的索引、input 回字串;`null` 是取消。
- **`hostPromptReady`**:頁面每次載入、裝好 listener 之後送一次。宿主在那之前把 prompt 留著不送。頁面重新載入時,還沒回答的 prompt 在新頁面說它準備好之後重送,不當成取消:git 可能正卡在一個帳密提示上,重新整理不該讓那次 push 失敗。實例被處置時,未回答的一律回答取消。
- **頁面的回覆不進 dispatch。** main process 在交給實例的 dispatch 之前,先用 `isHostPromptReply` 把回覆分給那個實例的 `Prompts`。「後果」要求的型別檢查是 `COMMANDS_STAY_APART`:`HostPromptMessage` 與 `ResponseMessage`、`HostPromptReply` 與 `RequestMessage` 的 command 交集必須是 `never`,否則編譯失敗。
- **只在 `graph` 頁裝 listener。** prompt 是 webview 實例在問,而 notice 頁背後沒有實例。之後的 Welcome page(#394)要問時,由它照這個協定接上。

## 補記(2026-11-17,#397)

**設定頁是桌面入口的第三種頁面(`data-ging-page="settings"`),開在自己的視窗裡,從 `ging://app/settings` 提供。** 頁面帶一段帶 nonce 的 inline script,給 bundle `settingsPage` 這個全域:每個設定一列(由 `schema.generated.json` 依 app 的語系轉出,值是當下讀到的)、主題的選擇、頁面自己的字串。控制項由 webview 依 schema 的型別決定(布林、enum、數字、字串,清單與物件用 JSON 文字框),沒有任何一列是手刻的。每一列的 id 就是設定的全名,#387 把 `` `#key#` `` 轉成的 `#key` 連結因此直接落在那一列上。

- **設定頁的訊息型別在 [desktop/settings/protocol.ts](../../packages/webview/src/desktop/settings/protocol.ts),不在 `RequestMessage` / `ResponseMessage`。** 頁面送出 `updateSetting`、`setTheme`;宿主回 `settingUpdated`(當下的值,以及沒存成時的原因)。「後果」第三條要求的「command 不得與 `ResponseMessage` 重疊」寫成了型別檢查(`SETTINGS_COMMANDS_DO_NOT_OVERLAP`)。設定頁不啟動圖形,所以頁面上只有一個 listener;它仍然略過不是 `settingUpdated` 的訊息。main process 依送出訊息的 `webContents` 分流:設定視窗的訊息不會進到任何 graph instance 的 dispatch。
- **設定頁的樣式由它自己的模組在啟動時插進一個 `<style>`,不放進 `media/main.css`,也不另開一個樣式表檔。** 「後果」只要求不放進會進 `.vsix` 的 `main.css`。另開檔案就得多一條 esbuild 複製、多一個 `PAGE_ASSETS` 白名單項目、harness 也要跟著搬;樣式跟著模組走,就只在桌面的 bundle 裡,CSP 的 `style-src 'unsafe-inline'` 本來就放行。等桌面專屬的樣式多到需要共用(側檢視 #399、working tree #403),再由那張票決定是否抽成檔案。
- **設定頁裡往外的連結(描述裡的 `https://`)用 `target="_blank"`,由設定視窗的 `setWindowOpenHandler` 交給 `Opener.openExternalUrl`;其他任何會換掉頁面的導覽都擋掉。** 頁面畫成外部連結的條件與視窗放行的條件是同一個 `isWebUrl`([webUrl.ts](../../packages/shared/src/webUrl.ts)),放在兩邊都能 import 的 `@ging/shared`。 在 #391 之前,`Opener` 是只寫 log 的過渡版,所以點下去暫時只會留一行 log。
- **入口是 #390 那份選單 template 的「設定…」(`ging.settings`,`CmdOrCtrl+,`),放在照 `fileMenu` role 寫出來的 File 選單裡([appMenu.ts](../../apps/desktop/src/appMenu.ts))。** 它不看有沒有圖形,一律可按。#396 長出完整選單時,這一項(連同 id 與 accelerator)要保留;要搬位置(例如 macOS 慣例的 app 選單)由那張票決定。
- **設定頁不裝 host prompt 的 listener(#390)。** 設定頁背後沒有 webview 實例,沒有誰會問;寫入失敗的原因直接顯示在那一列。
- **主題手動切換交給 Electron 的 `nativeTheme.themeSource`(`system` / `dark` / `light`),選擇存在 `HostStorage` 的 global 層,key 是 `desktopTheme`。** 啟動時在建立第一個視窗之前套用,所以第一次繪製就是對的顏色。設 `themeSource` 會讓 `shouldUseDarkColors` 改變並發出 `updated`,原本「跟著系統換主題」的那條路(#386)就把新主題推給每個視窗,圖形頁與設定頁一起換,不需要第二條推送路線。

## 補記(2026-11-17,#393)

**桌面版的視窗有兩層頁面：視窗自己的頁面(`data-ging-page="window"`,`ging://app/`)是分頁列加上它底下的 Welcome page;每個 Tab 是一個 `WebContentsView`,載入自己的圖形頁(`ging://app/tab?id=N`),由 main process 排在分頁列下方。**

- **一個 Tab 一份文件，不是一頁裡放好幾個圖形。** 上面「為什麼未來的讀者會困惑」第二條寫明 `gitGraphView.ts` 的狀態整個模組共用一份，`startGitGraphView()` 一頁只能呼叫一次。所以每個 Tab 要有自己的 webContents;用 `WebContentsView` 而不是 `<iframe>` 或 `<webview>`,是因為每個 Tab 因此有自己的 renderer,一個大 repo 的圖形不會卡住其他 Tab,reload 與 `did-start-navigation` 也照舊以 webContents 為單位(#388 的處理不必改)。
- **分頁列由 webview 畫，高度是固定的 `TAB_STRIP_HEIGHT`(35px),宣告在 [desktop/window/protocol.ts](../../packages/webview/src/desktop/window/protocol.ts)。** main process 依同一個常數擺 Tab 的 view,不量頁面。[windowPage.spec.ts](../../e2e/webview/windowPage.spec.ts) 驗分頁列真的是這個高度、Tab 橫排、名稱過長時截斷而不把關閉鈕擠出去。
- **協定:宿主送 `windowState`(整份分頁清單與 Welcome page 的說明),頁面回 `windowReady`、`focusTab`、`closeTab`。** 型別在 `desktop/window/protocol.ts`,`WINDOW_COMMANDS_STAY_APART` 檢查它們不與 `ResponseMessage` / `RequestMessage` 撞名。點分頁只是「請求」,分頁列等宿主送來新的 state 才改變。`windowReady` 與 `hostPromptReady` 同理：頁面每次載入都送一次，宿主在那之前不送。
- **Welcome page 裝了 host prompt 的 listener。** 「補記(#390)」說「之後的 Welcome page 要問時，由它照這個協定接上」;沒有 Tab 時，選單的命令(#396)與 #394 的開啟流程就問在這裡。有 Tab 時，Tab 的 view 蓋住 Welcome page,所以宿主只在沒有 Tab 時用它。
- **`notice` 頁仍在,但只給 Tab 用:** 重啟時路徑已經不在的 Tab,在原位置顯示「無法開啟」,直到使用者關掉它(GLOSSARY 的 Current repository:字串留著不刪)。啟動參數指錯路徑而沒有任何 Tab 時，說明改由 `windowState` 的 `notice` 畫在 Welcome page 上，不再換掉整頁。
- **分頁列的樣式由 `windowPage.ts` 插進一個 `<style>`,** 理由同「補記(#397)」的設定頁;只用 `theme.ts` 已經提供的 `--vscode-*` 變數(`apps/desktop/tests/theme.test.ts` 守住)。
- **「這個 Tab 在等回答」的標記只畫在後面的 Tab 上。** 前景 Tab 的 prompt 就在畫面上，不需要再提醒;背景 Tab 的 prompt 畫在看不見的頁面裡，分頁列是使用者唯一看得到它的地方。標記不會把那個 Tab 拉到前面：搶走使用者正在用的 Tab 比晚一點回答更糟。
- **Tab 的頁面不會被導覽走。** Tab 的 view 若被導覽到 `?id=M`,會畫出 Tab M 的圖形，訊息卻仍送到自己的實例。所以每個 Tab 的 webContents 擋掉 `will-navigate`、`window.open` 一律不開新視窗(網址交給 `Opener.openExternalUrl`),寫在 [pageGuard.ts](../../apps/desktop/src/pageGuard.ts) 的 `keepPageInPlace`,與設定視窗(「補記(#397)」)的規則相同;main process 自己的 `loadURL` 與重新載入不受影響。

## 補記(2026-11-17,#403)

**working tree 區由 working tree 面板填上:圖形頁上一個 `<aside id="workingTree">`,寬 `WORKING_TREE_WIDTH`(320px)、與視窗等高的 `position: fixed` 右側直欄。** 它在 [workingTreePanel.ts](../../packages/webview/src/desktop/workingTree/workingTreePanel.ts),只從桌面入口的 `graph` 頁啟動。

- **開著時 `body` 帶 `workingTreeOpen`,`padding-right` 讓出它的寬度。** 上面「後果」最後一條要 #403 處理的 docked Commit Details View 與 `#scrollShadow`,連同同樣 fixed 在右上角的 find widget,都在這個 class 底下讓出右緣。樣式照「補記(#397)」的做法由模組自己插進一個 `<style>`,只用 `theme.ts` 已經提供的 `--vscode-*` 變數。版面由 [workingTree.spec.ts](../../e2e/webview/workingTree.spec.ts)(webview E2E)驗:直欄貼右、等高,圖形、控制列與 find widget 的右緣都在它左邊,關掉後寬度還給圖形。
- **預設關著,開關記在頁面的 `localStorage`(`ging.workingTree.open`)。** 這只是每位使用者的便利:讀寫失敗就當成關著。打開它的入口是圖形自己的 Open Source Control View(uncommitted changes 那一列的選單),也就是 `openScmView` hook(ADR-0027 的同日補記);宿主送 `workingTreeShow`,面板打開並讀一次 status。`GraphInstance.showWorkingTree()` 送的是同一則訊息,留給應用程式選單(#396)接。
- **協定:頁面送 `workingTreeLoad`、`workingTreeStage`、`workingTreeUnstage`、`workingTreeCommit`;宿主對每一個都回一則 `workingTreeStatus`,帶著做完之後讀到的 status、失敗的原因,以及面板的字串。** 型別在 [protocol.ts](../../packages/webview/src/desktop/workingTree/protocol.ts),`WORKING_TREE_COMMANDS_STAY_APART` 檢查它們不與 `RequestMessage` / `ResponseMessage` 撞名。字串跟著每個回答來,理由同「補記(#390)」的按鈕文字:面板因此不依賴 `webviewL10n`,VS Code 的 bundle 也不帶這些字串。
- **面板畫的永遠是宿主回答的 status,不是它自己以為的結果。** 一個請求在外面時,所有按鈕停用;圖形被告知 `refresh`(檔案監看看到變更,或任何一次改動 repo 之後)時面板重讀一次,剛好有請求在外面就等它回來再讀。
- **面板的鍵盤事件停在面板。** 圖形的 `documentKeydown` 會把方向鍵、Enter、Space 拿去移動列;面板在自己身上 `stopPropagation`,所以焦點在面板裡時圖形的快捷鍵不作用。訊息框裡按 Ctrl+Enter(macOS 是 ⌘Enter,placeholder 由宿主依平台寫明)commit。
- **鍵盤到得了每個按鈕,重繪後也留在原處。** 每一列的按鈕平常淡出(`opacity: 0`),滑鼠移上或焦點在那一列時才顯示;不用 `visibility: hidden`,那會讓按鈕連 Tab 都到不了。請求在外時按鈕標 `aria-disabled`,不用 `disabled`:後者會把焦點從剛按下的按鈕上拿走。面板每次收到回答都整個重繪,重繪前記下焦點在哪個按鈕、哪個檔案,重繪後放回同一個;那個檔案已經離開這一組(例如剛被 stage),就放到接替它位置的那一列,再不然是那一組的「全部」按鈕。
- **一組最多畫 500 列,其餘只寫「還有 N 個檔案」。** 沒被 ignore 的建置輸出可能有上千個未追蹤檔;Stage All 仍點名全部,不只畫出來的那些。
- **點檔案列還沒有作用。** `startWorkingTreePanel({ showDiff })` 是留給 diff viewer(#404)的接縫:給了 `showDiff(file, area)`,檔案列才可以點、可以聚焦;#406 的 hunk stage 也從那裡進來。

## 補記(2026-11-17,#396)

**Show Statistics 的統計頁不是桌面入口的一種頁面，而是兩個宿主共用的一份完整 HTML 文件**([statisticsMarkup.ts](../../packages/webview/src/statisticsMarkup.ts)),桌面版從 `ging://app/statistics` 提供，開在自己的視窗裡([statisticsWindow.ts](../../apps/desktop/src/statisticsWindow.ts))。

- **為什麼不做成 `data-ging-page` 的第四種。** 統計頁沒有腳本、沒有互動，VS Code 也是把同一份 HTML 直接塞進一個 `enableScripts: false` 的 webview panel。做成入口的一種頁面，就得讓 bundle 為一頁只有 CSS 的東西啟動、再把畫面搬進 `desktop/`;直接共用文件，兩個宿主畫的是同一份東西，VS Code 的輸出不變(只是產生它的函式從 `apps/vscode` 搬到 `packages/webview`,字串改由呼叫端傳入的 `t` 取得)。
- **它在 `packages/webview`,不在 `desktop/` 底下,** 因為 VS Code 也用它;它只是產生字串的函式，不 import 任何會碰頁面的東西。圖形的資料型別由 core 的 `Statistics` 依形狀對上(`StatisticsFigures`),`packages/webview` 照 ADR-0026 不依賴 core。
- **主題。** VS Code 自己注入 `--vscode-*`;桌面版在提供頁面時把當下主題的變數寫在 `<html>` 的 `style` 上(與其他頁面相同),之後的主題切換照舊由 preload 套上。它用到的 `--vscode-charts-blue` 因此加進了 `theme.ts`(值取自 VS Code 色彩登錄的 `editorInfo.foreground`),`apps/desktop/tests/theme.test.ts` 掃 `packages/webview` 時會守住它。
- **頁面不會被導覽走、也不開新視窗**(`keepPageInPlace`,同 #393 的 Tab)。`serveApp` 因此多了一種回答:除了組成入口頁面的 `PageContent`,也可以是整份文件(`{ document }`);沒有統計資料時 `ging://app/statistics` 是 404。

## 補記(2026-11-17,#394)

**Welcome page 有了內容：開啟資料夾、初始化存放庫兩個入口，以及最近使用清單。仍是視窗自己的頁面畫，協定照「補記(#393)」的形狀長出來。**

- **`windowState` 多一欄 `welcome`**(入口的文字與最近使用清單,[desktop/window/protocol.ts](../../packages/webview/src/desktop/window/protocol.ts) 的 `WelcomeContent`)。有 Tab 時是 `null`:Tab 的 view 蓋住 Welcome page,而清單的每一列都要看一次磁碟(`missing`),沒人看的時候不算。
- **頁面多四種請求:`openFolder`、`initRepo`、`openRecent`、`forgetRecent`**,後兩者帶清單上那一列的 `path`。和點分頁一樣只是「請求」:選資料夾、檢查、開成 Tab 都是宿主的事，頁面等新的 `windowState`。`WINDOW_COMMANDS_STAY_APART` 照舊檢查它們不與 `RequestMessage` 撞名。
- **啟動參數指錯路徑的說明(`notice`)畫在入口與清單之上**,同一個 `.welcomeBody` 裡：說明之後，使用者馬上能從同一頁改開別的資料夾。
- **clone 的入口不在這裡。** 票面把它列為 Welcome page 的入口之一，但 clone 本身是 #395;沒有功能的按鈕不先放，由 #395 連同它的流程一起加進 `welcomeHtml`。
- 樣式仍由 `windowPage.ts` 插進同一個 `<style>`,只用 `theme.ts` 已提供的 `--vscode-*` 變數(`apps/desktop/tests/theme.test.ts` 守住)。版面由 [windowPage.spec.ts](../../e2e/webview/windowPage.spec.ts) 驗：每一列一行、過長的路徑截斷而不把「移除」鈕擠出去、找不到的資料夾標出來。

## 補記(2026-11-17,#399)

**側檢視區已經填上:`<aside id="sideViews">`,由桌面入口在圖形頁啟動圖形之後建立,插在 `<body>` 的第一個位置。**它照上面骨架的約定:視窗左緣、與視窗等高、`position: fixed`,寬度是 `--ging-side-view-width`(260px,[styles.ts](../../packages/webview/src/desktop/sideViews/styles.ts) 的 `SIDE_VIEW_WIDTH`);`body.gingSideViews` 擁有 `padding-left`。「後果」最後一條要 #399 做的那一半也做了:docked Commit Details View 與 `#scrollShadow.active` 的左緣讓出欄寬,右緣不動,留給 #403。

- **「誰先合併都只動自己那一邊」在 `#scrollShadow` 上守不住,所以兩欄都在時多一條規則。**#403 用 `width: calc(100% - 欄寬)` 讓出右邊;左緣一移,同一個寬度會讓它伸進 working tree 的欄位裡。側檢視的樣式因此在兩個 class 都在時(`body.gingSideViews.workingTreeOpen`)改用左右兩緣定位,右緣讀 #403 的 `WORKING_TREE_WIDTH`。docked CDV 用的是 `left` / `right`,兩邊本來就各管各的。[sideViews.spec.ts](../../e2e/webview/sideViews.spec.ts) 在兩欄都在時驗兩者都落在兩欄之間。

- **樣式由側檢視模組在啟動時插進一個 `<style>`**,理由同 #397、#393 的補記;只用 `theme.ts` 已經提供的 `--vscode-*` 變數。[sideViews.spec.ts](../../e2e/webview/sideViews.spec.ts) 在真的瀏覽器裡驗欄位的位置與尺寸、`body` 的 padding、frozen header 從欄位右緣開始、捲動時欄位不動,以及 docked CDV 與 scroll shadow 的左緣。
- **元素在 `<body>` 裡,所以圖形的 `#dialog` 開著時它跟著被標成 `inert`。**這是要的:圖形的對話框是 modal,側檢視不該在它背後還能按。host prompt overlay 仍在它之上(#390 的補記)。
- **協定:宿主送 `sideViewState`(兩個檢視的整份內容、選單的可見度設定、檢視自己的字串),頁面回 `sideViewReady`、`sideViewRefresh`、`sideViewToggle`、`sideViewSetFilter`、`sideViewNoTargets`、`sideViewAddRemote`、`sideViewManagePullRequestProviders`、`sideViewRemote`。**型別在 [desktop/sideViews/protocol.ts](../../packages/webview/src/desktop/sideViews/protocol.ts),`SIDE_VIEW_COMMANDS_STAY_APART` 檢查它們不與 `ResponseMessage` / `RequestMessage` 撞名。`sideViewReady` 與 `hostPromptReady` 同理:頁面每次載入都送一次,宿主在那之前不送。main process 在交給 dispatch 之前用 `isSideViewRequest` 把它們分給該實例的側檢視,dispatch 聽不到。
- **分支動作的字串是圖形的(頁面的 `l10n`),批次動作與檢視自己的字串由宿主隨 state 送來。**同一個動作在圖內選單與側檢視叫同一個名字;批次動作圖形沒有選單,`webviewL10n` 不為桌面多帶 VS Code 用不到的字串。
- **`gitGraphView.ts` 多了一個回傳值,沒有 import 任何 `desktop/` 底下的東西。**`startGitGraphView()` 回傳 `GraphInPage`,側檢視經由它直接呼叫圖形(ADR-0033)。VS Code 入口忽略它。

## 補記(2026-11-17,#407)

**working tree 面板長出 Amend 與 Sign off 兩個勾選框;amend 已推送的 commit 前要問,問在圖形自己的 `#dialog`,不是 host prompt overlay。** 圖形頁要問使用者的事用 webview 自己的對話框(ADR-0027),面板與圖形同一頁,所以它也是。

- **`gitGraphView.ts` 多一個 export:`askInGraphDialog(html, actionName, confirmed)`。** 它走 `raiseAnswerDialog`:使用者自己的對話框開著時排隊等它關,不寫掉它;其餘情況立刻出現。桌面入口把它交給面板(`startWorkingTreePanel({ confirm })`),面板不 import `gitGraphView.ts`,jsdom 測試注入假的。VS Code 入口不呼叫它,行為不變;這是共用檔案為桌面入口開的接縫,不是讓圖形認得桌面的元素。對話框開著時面板跟 `<body>` 的其他子元素一樣是 `inert`;關掉後焦點回到 commit 鈕(它有固定的 `id`,面板重繪換掉元素也找得回來)。[workingTree.spec.ts](../../e2e/webview/workingTree.spec.ts) 驗這一段。
- **擋在 core,不只擋在畫面。** core 的 commit 在 amend 而 HEAD 已在任何 remote-tracking branch 上(`for-each-ref --contains=HEAD refs/remotes/`,略過 symref)時拒絕,回答 `refused: { kind: "pushed", head, remoteBranches }`;面板問完、使用者說要,才帶 `rewritePushed: head` 重送同一個請求。同意綁在問的那個 commit 上:問題可能排在別的對話框後面,HEAD 在那之前移動了,core 就以新的 HEAD 再拒絕一次,面板再問。照 force push 的慣例:沒有設定項,不記住,每次都問。
- **協定只多選填的欄位。** `workingTreeCommit` 的 `amend`、`signOff` 只在為 true 時帶,`rewritePushed` 只在使用者同意過時帶,#403 的請求形狀不變;`workingTreeStatus` 多 `amend`(HEAD 的訊息,或不能 amend 的原因:unborn、merge、rebase、cherry-pick、revert)與選填的 `refused`。字串照舊跟著回答來。
- **拒絕不算改動。** 拒絕的理由(不能 amend、已推送、git 不知道 committer 是誰)在 `runRepoMutation` 之外先查(`refuseCommit`),所以被拒的 commit 不靜音 watcher、不重新整理圖形;服務接著呼叫 `commitChanges` 時告訴它已經查過("checked"),不查第二次。單獨呼叫 `commitChanges` 的人仍由它自己查。
- **勾選框只在頁面存活期間記得。** Sign off 是對某個專案的聲明(DCO),記在 `localStorage` 會變成每個 repo 都簽;要記住得先讓頁面知道自己是哪個 repo。Amend 成功後取消勾選;勾 Amend 時訊息框是空的才填入 HEAD 的訊息,取消勾選時內容仍是那段原文才清空。
