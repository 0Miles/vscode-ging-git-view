---
status: accepted
---

# 中文選單文案的第一個 token 必須是動作,即使語序因此不自然

出現在**可掃視的動作清單**——圖形右鍵選單、原生側檢視右鍵選單、命令面板、QuickPick——的中文文案,動作一律放在句首。因此 `action.rebaseOnBranch` 是「Rebase 目前 branch 到此 branch」,不是自然中文會寫的「將目前 branch rebase 到此 branch」。

這條規則**只管位置**。動作詞用英文(`Rebase`、`Reset`、`Fetch`)或中文(`建立`、`捨棄`、`複製`)不在管轄範圍內,沿用既有翻譯即可。

## 為什麼未來的讀者會困惑

「將 A rebase 到 B」才是通順的中文;「Rebase A 到 B」讀起來像機翻。任何懂中文的讀者(或 agent)看到這批字串,第一直覺都是把它「修好」回介係詞開頭的形式。

不要修。選單文案不是拿來**讀**的,是拿來**掃**的。使用者右鍵之後眼睛沿著左邊界往下跳,一列只看前幾個字;動作藏在句子中段時,整個選單裡就找不到「Rebase 在哪」。介係詞開頭的譯法把每一列的前兩個字都變成了資訊量為零的「將」「從」「在」。

這也是為什麼 tooltip 與單一按鈕**不適用**這條規則(`action.fileLayoutTree` 維持「以檔案樹檢視變更」、`conflict.openInMergeEditor` 維持「在 merge editor 中開啟」)——它們一次只出現一個,沒有掃視成本,強行倒裝只換來更難讀的中文。

## 考慮過但否決的方案

**git porcelain 動詞一律保留英文並置於句首。** 更徹底:「捨棄此 commit」→「Drop 此 commit」、「套用 stash」→「Apply stash」、「刪除 branch」→「Delete branch」。理由是眼睛真正在找的錨點是英文動詞。否決原因是它把「刪除」「複製」「開啟」這類通用動詞也一併英文化,那些詞的中文形式並不影響掃視(它們本來就在句首),英文化後反而降低可讀性;而且範圍從 11 條膨脹到數十條,與這次要解決的問題不成比例。

**加進 `scripts/check-l10n.js` 做 CI 檢查。** 判準是可行的:把規則限縮在 `action.*` 與 `command.*` 兩個前綴(結構上就等於「動作清單」),外加 `reflog.createBranch` / `reflog.resetHard` 納入、`action.fileLayoutTree` / `action.fileLayoutList` 排除,則修正後違規數為零。否決原因是它只是**首字啟發式**——擋得住「以中文介係詞開頭」,擋不住動作掉到句尾(「remote 全部 fetch」照樣過關),付出一組要維護的 include/exclude 名單,換來的卻是「跑過了就沒問題」的偽安全感。

## 後果

- 「動作在句首」與「動作用什麼語言」是兩條獨立的軸,而這裡只釘死了前者。因此同一個 QuickPick 裡會並列「建立 branch 於此」(中文動詞)、「Reset 目前 branch 到此(hard)」(英文動詞)、「複製 commit hash」(中文動詞)。這是明知的取捨,不是漏改。
- 英文原文不受影響——`package.nls.json` 與 `bundle.l10n.json` 本來就全部動作在前,這條規則只存在於中文語系。
- 沒有機械檢查,所以新增選單文案時漂移會再次發生。這正是 `action.reset` 守住了規則而 `action.resetFileToRevision` 沒守住的原因。
- 順帶統一了 `zh-CN` 的 `command.branches.*`:原先 18 條全用「分支」、與同語系 `bundle.l10n.zh-cn.json` 的 55 處 `branch` 相左,現已全部改用 `branch`。**但 `package.nls.zh-cn.json` 的 `config.*` 描述仍有多處「分支檢視」等寫法未動**,該語系的術語統一並未完成。
- `view.branches` 兩個語系都維持「分支」。那是側檢視的**名稱**,不是動作文案,譯成中文是對的。
