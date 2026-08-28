---
status: accepted
---

# Pull request 的 provider 是「host → forge 型別」的設定,不是程式裡的 host switch

`ging-git-view.pullRequests.providers` 是一個陣列,每筆只有兩個必要欄位:`host`(remote 的主機名稱)與 `type`(那台主機上跑的是哪一種 forge:`github` / `gitlab` / `bitbucket` / `gitea` / `custom`)。URL 長什麼樣由 `type` 決定,寫在 [pullRequest.ts](../../src/backend/utils/pullRequest.ts) 的 `BUILT_IN_TEMPLATES` 裡;使用者只在 `type: "custom"` 時才需要自己寫 `urlTemplate`。五個公開 host(github.com、gitlab.com、bitbucket.org、gitea.com、codeberg.org)以同樣的資料形狀內建,不必設定就能用,而同名 host 的設定會**整筆取代**內建那筆。

改這份清單的 UI 是 `ging-git-view.managePullRequestProviders` 指令([pullRequestProviders.ts](../../src/extension/pullRequestProviders.ts))—— 它是設定的**檢視**,不是第二個儲存處:每次寫入都落在一個具名的 settings scope,而且把寫到哪裡直接講給使用者聽。它掛在 **Remotes 側檢視的標題溢位選單**上,不是 Branches。

## 為什麼未來的讀者會困惑

在此之前,這件事就是 `pullRequestCreateUrl` 裡一個三案的 `switch (host)`。三行變成一個帶正規化、帶優先序、帶 QuickPick 流程的模組,看起來像是為了三個公開 host 過度設計。

而且上游 `Git Graph` 對同一件事的解法是相反的:它的 `customPullRequestProviders` 只有 `name` 與 `templateUrl`,每個 provider 都得自己把 URL 拼出來;至於某個 repo 用哪個 provider,則存在擴充功能自己的 workspace state 裡,設定檔上看不到。第一直覺會是「照抄上游那套就好,至少相容」。

不照抄的理由,正是這個 fork 收到的原始需求:使用者說不出 pull request 的設定存在哪裡。**存在哪裡看不見**,和**設定要寫什麼很難**,是同一個問題的兩面 —— 前者靠「只寫進 settings.json、不碰 workspace state」解決,後者靠「宣告 forge 型別而不是宣告 URL」解決。自架 Gitea 的人知道自己跑的是 Gitea,不見得知道 Gitea 的 compare URL 長怎樣。

`type: "gitea"` 同時涵蓋 Forgejo(含 Codeberg)不是含糊帶過:兩者的 compare 路由是同一段程式碼的後裔,而 `/{owner}/{repo}/compare/{branch}` 這種不含 `...` 的寫法,兩邊都解讀成「拿預設分支比對這一條」,正好是要落地的那一頁。

## 考慮過但否決的方案

**沿用上游的 `{name, templateUrl}` 形狀。** 相容性最高,自由度也最高。否決原因是它把「你用哪個 forge」這個使用者知道的事實,換成「那個 forge 的 URL 怎麼拼」這個使用者不知道的事實 —— 而 Gitea 使用者要的正是不必查這個。`type: "custom"` 保留了這條路,但它是逃生門,不是預設。

**每個 repo 存一筆 provider(如上游),而不是每個 host 存一筆。** 否決原因是 provider 是 host 的性質,不是 repo 的性質:同一台自架 Gitea 上的十個 repo,設定十次是重複勞動,而且第十一個 repo 又會失敗一次。

**給 Gitea 內建一個 host。** 沒有這種東西 —— Gitea 的本質就是自架。內建的 `gitea.com` 與 `codeberg.org` 是兩個真實存在的公開實例,不是「Gitea 的預設 host」。

**做一個 webview 設定頁。** 圖形內沒有任何設定 UI,而 `manageRemotes` 已經立下「這類管理工作用 QuickPick 指令」的先例([extension.ts](../../src/extension.ts))。多開一種設定介面,只會多一個使用者要找的地方。

## 後果

- **分支名裡的 `/` 不再被編碼成 `%2F`。** 舊的實作對整個分支名做 `encodeURIComponent`;現在逐段編碼、保留 `/`。forge 的路由吃的是原始的斜線,而 `/` 在 path 與 query value 兩種位置都是合法字元,所以一套編碼規則同時服務四種內建型別。
- **GitLab subgroup 現在會對。** URL 樣板用 `{path}`(remote 路徑原封不動)而不是 `{owner}/{repo}`,所以 `group/sub/proj` 不會在第一個斜線被切掉。`{owner}` 與 `{repo}` 仍供 custom 樣板使用,切點在**最後**一個斜線。
- **設定不合法的那一筆會被靜默丟掉,不是整份設定失效。** `normalizePullRequestProviders` 逐筆檢查(缺 host、型別不認得、custom 樣板沒有 `{branch}`),留下能產出 URL 的。半打好的一筆不會變成一條壞連結。
- **`{branch}` 是 custom 樣板的硬性要求,設定與 UI 同一條規則。** 沒有 `{branch}` 的樣板開出來的連結會忽略分支,那不是「create pull request from this branch」;quick-pick 的 `validateInput` 擋它,`normalizePullRequestProviders` 也擋它 —— 否則手寫進 settings.json 就能繞過。至於樣板指到一個合法但無用的 URL,沒有任何驗證擋得住,界線就畫在「UI 要求的那個佔位符」。
- **URL 的 scheme 跟著 remote 走,不是寫死 https。** remote 是 `http://` 就開 http,其餘(含 ssh 與 scp 式 remote,它們對 web UI 沒有任何表示)一律 https。內建樣板因此以 `{scheme}://` 開頭。少了這一條,只在內網跑 http 的自架 forge 會被推去用 `custom`,而那正是這個設定要省掉的事。
- **跨 scope 的陣列不會合併。** VS Code 的陣列設定是最具體的 scope 整份勝出,所以編輯必須回寫到**目前生效的那個 scope**,否則會像沒存到一樣。`activeScope()` 就是為這件事存在的,而使用者看到的訊息會指名是哪個 scope。
- **失敗的路徑會通往修好它的地方。** 沒有 provider 時的錯誤訊息帶一個「設定 provider」按鈕,直接把偵測到的 host 帶進指令 —— 使用者不必再去找那個設定叫什麼名字。
- **入口掛在 Remotes 而不是 Branches,雖然按鈕是從分支上按的。** 「建立 pull request」確實是分支的動作,所以第一直覺會把設定入口放在 Branches 側檢視旁邊。但要設定的東西不是分支,是 **host** —— 而 host 只存在於 remote 的 URL 裡,Remotes 側檢視就是使用者心裡放 host 的地方。放進 Branches 會暗示這份設定是 per-branch 或 per-repo 的,那正是這個 ADR 拒絕的模型。
- **沒有設定頁,而命令面板的入口只有知道它存在的人找得到。** 這是加上側檢視選單那一條的原因。VS Code 的設定編輯器對 `array` of `object` 一律只給「在 settings.json 中編輯」連結,做不出表單,所以「在設定裡找得到」不等於「在設定裡改得動」。
- **只有 `parseRemoteUrl` 認得的 remote 能走這條路。** 它處理 `https://`、`ssh://`、scp 式的 `git@host:path`、含 port 的 http(s);認不出來(例如本機路徑)就據實回報「這個 remote 不支援」,而不是猜。
