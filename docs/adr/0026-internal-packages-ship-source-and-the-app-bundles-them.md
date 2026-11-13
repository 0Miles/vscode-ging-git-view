---
status: accepted
---

# monorepo 的內部套件只交出原始碼,由各 app 的 esbuild 打包;擴充仍以 repo 根目錄發版,文件與 l10n 在打包時才複製進去

這個 repo 是一個 pnpm workspace:`packages/shared`(`@ging/shared`)、`packages/core`(`@ging/core`)、`packages/webview`(`@ging/webview`)三個內部套件,加上 `apps/vscode`(擴充本體 `ging-git-view`);桌面版的 `apps/desktop` 留到階段 B 才建立([#291](https://github.com/0Miles/vscode-ging-git-view/issues/291))。內部套件一律是 **source-only**:`private`、版號 `0.0.0`,`exports` 直接指向原始碼與原始資產 —— `./src/*.ts`,以及 shared 的 `./l10n/*`、webview 的 `./media/*`,core 另外匯出測試用的 `./tests/helpers` —— 自己沒有 build、沒有 `out/`、不產生 `.d.ts`。把它們變成可執行檔案的只有 app —— `apps/vscode/esbuild.js` 從各套件的 `exports` 找到入口,打出 `out/extension.js`、webview 的 bundle,以及 askpass 與 sequence editor 兩支 helper,跟重構前的建置方式一模一樣。

依賴方向只有兩條:`shared ← core ← apps/*`,以及 `shared ← webview ← apps/*`。**webview 永遠不依賴 core**(core 帶著 `simple-git`、`iconv-lite` 與 `node:fs`,一旦 import 進來就被打進瀏覽器的 bundle),**任何套件都不依賴 app**。兩邊都要讀的東西 —— wire 協定的型別、ADR-0010 的 action catalogue、`contextMenuVisibility` 的預設值 —— 因此只能放 shared;shared 也在 oxlint 裡同時關掉 node 與 browser 的全域,兩種執行環境都得跑得動。

## 為什麼未來的讀者會困惑

- **套件不 build 自己,看起來像沒做完。** 一般的 monorepo 讓每個套件各自編譯、互相依賴編譯產物。這裡沒有人消費這些套件的產物:它們從不發佈,repo 外沒有使用者,而擴充功能出貨的是 esbuild 打好的單一 bundle(`vsce package --no-dependencies`)。各自 build 只會多出一條 build 順序、一串 watch、一份可能過期的 `out/`,換不到任何使用者拿得到的東西。A1–A3 的每一步都拿 `.vsix` 比對過搬移前的版本,見 #318。`apps/vscode` 把 `@ging/*` 列在 `devDependencies` 也是同一個理由 —— 它們在打包時就被吃進 bundle 了。
- **邊界的主要防線是「沒列依賴」,不是 lint。** 只有 `apps/vscode/package.json` 列了 `@types/vscode`;webview 的 `package.json` 沒有列 `@ging/core`。pnpm 不 hoist,沒列的依賴根本解析不到,所以在 `packages/*` 寫 `import "vscode"`、或在 webview import core,typecheck 直接報 TS2307。CI 的 `actions/checkout` 是乾淨的 checkout,這條防線在那裡完整成立。
- **那為什麼還有一條 oxlint 規則?** 因為 Node 的模組解析會往上層目錄找 `node_modules`。這個 repo 的 worktree 開在主 checkout 底下(`.claude/worktrees/…`),主 checkout 的 `node_modules` 裡只要有 `@types/vscode`,巢狀 worktree 裡的套件就找得到它,typecheck 在本機放行(#294 實測過)。所以 `.oxlintrc.json` 對 `packages/**` 另外設了 `no-restricted-imports`,禁止 `vscode`。webview → core 沒有同樣的洞 —— workspace 套件不會出現在任何上層的 `node_modules`,在巢狀 worktree 裡試 import 一樣是 TS2307 —— 所以沒有替它加規則。哪天這個前提不成立,補法就是照抄那條規則。也因此,巢狀 worktree 裡 typecheck 通過不代表 CI 也會通過:本機少了「沒列依賴就解析不到」那一層保證,lint 只補了 `vscode` 這一個名稱。
- **release-please 的 component 仍然是 `.`,不是 `apps/vscode`。** release-please 只看 component 路徑底下的 commit。重構之後擴充功能的程式碼大半住在 `packages/*`,若 component 設成 `apps/vscode`,一個只改到 `packages/core` 的 `fix:` 不會讓擴充升版 —— 但它改的正是下一版要出貨的東西。所以 component 維持 `.`(`"component": "ging-git-view"`、`include-component-in-tag: false`,tag 接續 `v*`),另用 `extra-files` 把版號同步寫進 `apps/vscode/package.json` 的 `$.version`。這組設定還沒有實際發過一版,端到端的驗收是 [#296](https://github.com/0Miles/vscode-ging-git-view/issues/296)。
- **README、CHANGELOG、LICENSE 與 `resources/icon.png` 留在 repo 根目錄,打包時才複製進 app。** README 是 repo 在 GitHub 上的首頁,CHANGELOG 由 release-please 寫在 component 路徑 `.` 底下。icon 更動不得:vsce 會把 README 裡的相對圖片連結改寫成 `https://github.com/0Miles/vscode-ging-git-view/raw/HEAD/resources/icon.png`,已經上架的 0.8.0 與 0.9.0 的 Marketplace 頁面引用的就是這個網址,搬走它等於回頭弄壞已發佈版本的頁面。複製由 `apps/vscode` 的 `copy-docs` 在 `vscode:prepublish` 時做,複製出來的檔案列在 `.gitignore`。
- **l10n bundle 住在 `packages/shared/l10n`,不在擴充裡。** VS Code 要求 manifest 的 `"l10n": "./l10n"` 指向擴充自己的資料夾,但桌面版要讀同一份字串。所以 bundle 放 shared,`esbuild.js` 每次 build(compile、watch、production)都把整個資料夾重建進 `apps/vscode/l10n`,那個資料夾同樣被 gitignore。`package.nls*.json` 是 manifest 的字串,只屬於 VS Code,留在 app。

## 考慮過但否決的方案

- **每個內部套件各自 build,app 依賴編譯產物。** 理由見上。
- **改用 `tsc -b` project references。** 它能消掉現在的一個重複:每個套件的 `typecheck` 會把它 import 到的其他套件原始碼一併檢查一遍。代價是改寫每一份 `tsconfig`,而重複只是 CI 時間。#331 刻意沒做,現在也不做;它不改變「套件不出產物」這個決定,只改型別檢查的分工。
- **release-please 的 component 改成 `apps/vscode`。** 只改到 `packages/*` 的 commit 不會觸發擴充升版,見上。#291 列過的另一個候選 —— 維持 `.` 再用 `exclude-paths` 排除 `apps/desktop` —— 解的是另一個問題(桌面版的 commit 會讓擴充升版),`apps/desktop` 出現時採用了,見下方「補充」。
- **把 icon 與 README 搬進 `apps/vscode`。** 擴充的檔案會集中一處,但 icon 的網址已經寫死在線上的 Marketplace 頁面,見上。
- **只靠 lint 規則守邊界,不靠依賴宣告。** lint 守的是一個 import 名稱;依賴宣告守的是整張依賴圖 —— 套件 import 了任何沒列的東西都過不了 typecheck。lint 規則的角色見上面「那為什麼還有一條 oxlint 規則?」。

## 後果

- **core 需要宿主的能力時,透過 ADR-0027 的 host ports 拿**,不是 import `vscode`。
- **`apps/desktop` 出現時,要回頭看兩件事**:release-please 是否要 `exclude-paths`,以及哪些根目錄的檔案桌面版也要複製一份。

## 補充:`apps/desktop` 出現之後([#386](https://github.com/0Miles/vscode-ging-git-view/issues/386))

**release-please 的 `.` 加上 `"exclude-paths": ["apps/desktop"]`。** component 仍是 `.`,理由同上;不處理的話,`apps/desktop` 底下的 `feat:` / `fix:` 會讓擴充升版,也會寫進擴充的 CHANGELOG,而那些變更一行都不在 `.vsix` 裡。

`exclude-paths` 的判準是**整個 commit**:一個 commit 改到的檔案**全部**在 `apps/desktop/` 底下,它才被略過;只要有一個檔案在外面,它就照常算進擴充。這是 release-please 的 `CommitExclude.shouldInclude`(`src/util/commit-exclude.ts`,release-please 15.10.0 起;`release-please-action@v5` 用的是 `^17.6.1`)的行為,而且過濾發生在 `Manifest.buildPullRequests()` 把 commit 交給 strategy 之前,所以版號與 CHANGELOG 看到的是同一份過濾後的清單。實際跑一次 dry-run 要 GitHub token,所以佐證用的是本機可重現的推導:把那段判準套在 `git log --name-only` 上,見 #386 的 PR 說明。

由此而來的慣例:

- **桌面版的功能 commit 只改 `apps/desktop/`。** 同時動到 lockfile、根目錄的 `package.json`、`.oxlintrc.json`、CI 這類共用檔案的部分,拆成另一個不升版的 commit(`build:`、`ci:`、`chore:`)。混在一起的 `feat(desktop):` 會讓擴充升一個 minor,CHANGELOG 也會多一行跟擴充無關的條目。
- **`packages/*` 的變更一律算進擴充**,即使呼叫端只有桌面版:它們被打進擴充的 bundle,出貨的就是改過的程式碼。這正是 component 維持 `.` 的理由,`exclude-paths` 不改變它。
- **`pnpm-lock.yaml` 不排除。** 它也記著擴充的依賴,一個只改 lockfile 的 `fix(deps):` 可能就是擴充 bundle 裡的修正。所以桌面版加依賴的 commit 用 `build(deps):`。

**沒有改的**:桌面版自己的版號與發佈。`apps/desktop` 的 `version` 是 `0.0.0`、`private`,不是 release-please 的 package;它的 release pipeline 在階段 E。屆時若要讓 release-please 管桌面版,再把它加成第二個 package,並重新檢查這裡的 `exclude-paths` 與根目錄 package 的關係。

**根目錄要複製給桌面版的檔案**(本 ADR「後果」的第二件事):目前沒有。桌面版還不打包,README、CHANGELOG、LICENSE、icon 要不要、怎麼放進安裝包,由階段 E 的打包決定。
