---
status: accepted
---

# Force with lease 的意思是「已整合」,不是「已 fetch」;用 `-c` 設定鍵開啟,不用 CLI 旗標

Push 的「Force with lease」模式送出 `git -c push.useForceIfIncludes=true push --force-with-lease <remote> <branch>`。不論 auto-fetch 有沒有開都這樣送,也不偵測 git 版本。

## 為什麼未來的讀者會困惑

這裡有兩件反直覺的事,各自都很容易被「修正」回去。

**第一,手動 Fetch 之後的 lease push 也會被拒。** 不帶預期值的 `--force-with-lease` 拿本機的 remote-tracking ref 當預期值,而 auto-fetch 會在背景把它更新成遠端最新值 —— 使用者沒看過、沒整合的同事 commit 就這樣成了「預期值」,lease 通過,commit 被蓋掉([#193](https://github.com/0Miles/vscode-ging-git-view/issues/193))。`push.useForceIfIncludes` 另外要求遠端 tip 出現在本機分支的 reflog 裡,也就是真的整合過。

git 分不出 tracking ref 是被誰更新的:graph 的 Fetch 按鈕、GING 的 auto-fetch、VS Code 內建的 `git.autofetch` 效果完全相同。所以這個保護不能只在 auto-fetch 開啟時加 —— 只防其中一種來源說不通。代價是:按了 Fetch、看到同事的 commit、卻刻意不整合就想 lease push,現在會被拒。真的要覆蓋就用「Force」,那是使用者另外做出的選擇。

**第二,用 `-c push.useForceIfIncludes=true`,不用 `--force-if-includes`。** 兩者在 git ≥ 2.30 效果相同(2.40.1 實測,拒絕原因都是 `remote ref updated since checkout`)。差別在舊版:

- git < 2.30 不認得 `--force-if-includes`,回報 `unknown option`(exit 129),**整個 push 失敗**。
- git < 2.30 不認得 `push.useForceIfIncludes` 這個設定鍵,會**直接略過**,行為和現在的 bare lease 一樣。已以 git v2.29.0 原始碼確認:`-c` 只檢查鍵名語法(`config.c` 的 `git_config_parse_parameter`),`git_push_config` 把不認得的鍵交給 `git_default_config`,後者回傳 0。**未在實際的 < 2.30 binary 上執行驗證。**

所以舊版 git 的使用者 push 照常成功,只是得不到新的保護 —— 這件事寫在 `config.autoFetchEnabled` 的說明裡,執行時不提示。

## 考慮過但否決的方案

**先偵測 git 版本,≥ 2.30 才加 `--force-if-includes`。** 要處理版本字串解析(`2.40.1.windows.1`、Apple Git),還要一份在 `gitClient` 換 repo 或換 git 路徑時跟著失效的快取,讀不出版本時還得選一個預設。`-c` 做法把這些全部省掉。

**失敗後退回:遇到 unknown option 就改用 bare lease 重試。** 辨認失敗要比對 ``unknown option `force-if-includes'``,而這句經過 git 的 `_()` 翻譯,我們又沒有固定 `LANG`;多個 remote 平行 push 時逐一重試也很亂。

**只在 `autoFetch.enabled` 為 true 時加。** 只修 GING 自己造成的那一半,手動 Fetch 和 VS Code 內建 autofetch 的漏洞照舊。

**明確帶預期值 `--force-with-lease=<branch>:<sha>`。** 要追蹤「使用者最後一次看過的 tracking ref」,複雜得多。而且帶了明確預期值時,git 會**忽略** `push.useForceIfIncludes` —— 日後如果有人改成這種寫法,這裡的保護會默默消失。

## 後果

- **沒有 reflog 的分支會被誤擋。** `core.logAllRefUpdates=false` 時,連正常的 amend 後 lease push 也會被拒,因為 reflog 裡找不到遠端 tip。非 bare repo 預設有 reflog,所以接受;遇到時改用「Force」。
- **拒絕判斷比對的是 git 不翻譯的原因字串** `remote ref updated since checkout`,hint 會翻譯所以不拿來比對。host 回傳 `remoteUpdatedSinceCheckout` 這個事實,文案由 webview 組 —— 而且不斷言「遠端有新 commit」,因為上一條的誤擋情境裡遠端根本沒有新 commit。
- **三種 push 模式都改走 `git.raw(["push", …])`**,不再經過 simple-git 的 `git.push`(它會自動補 `--porcelain`)。所以 normal 與 force 模式被拒時的錯誤字串格式也跟著變成人類可讀的那一種。
- 使用者自己在 git config 設的 `push.useForceIfIncludes=false` 會被 `-c` 蓋過。這個模式的語意由 GING 定義,和在命令列直接加旗標一樣。
