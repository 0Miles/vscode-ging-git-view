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
