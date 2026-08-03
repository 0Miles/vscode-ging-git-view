# Changelog

## [0.2.0](https://github.com/0Miles/vscode-ging-git-view/compare/v0.1.0...v0.2.0) (2026-08-03)


### Features

* add button at scm title ([#43](https://github.com/0Miles/vscode-ging-git-view/issues/43)) ([6477346](https://github.com/0Miles/vscode-ging-git-view/commit/6477346402abcd3adade1d45642d0225163dc710))
* add initial test suite and CI configuration ([#7](https://github.com/0Miles/vscode-ging-git-view/issues/7)) ([0b66a23](https://github.com/0Miles/vscode-ging-git-view/commit/0b66a238fd8d1e474e38be37db82151464512413))
* add internationalization support ([#35](https://github.com/0Miles/vscode-ging-git-view/issues/35)) ([59374d6](https://github.com/0Miles/vscode-ging-git-view/commit/59374d613dccf6e299654bbadc302685a660c2cd))
* Branches & Remotes sidebar views ([28be27e](https://github.com/0Miles/vscode-ging-git-view/commit/28be27e346a71973654d14389889a8ddb214d25c))
* **branches:** check whether a branch still has unmerged changes ([ec427e9](https://github.com/0Miles/vscode-ging-git-view/commit/ec427e95b72093e84f74892b17c2276da27c6b7b))
* **branches:** date the branch the unmerged check measured against ([7397892](https://github.com/0Miles/vscode-ging-git-view/commit/73978920141654e8cb3b66119e8c5e5820ed7176))
* **branches:** date the check's basis from the reflog when there is one ([47afb2e](https://github.com/0Miles/vscode-ging-git-view/commit/47afb2e7da997296b2c6919ac9f284c682057095))
* **branches:** list the branch's commits in the unmerged-changes dialog ([047015d](https://github.com/0Miles/vscode-ging-git-view/commit/047015da98a88420a72a30f77f48639f0f6058e7))
* **branches:** mark and hide branches merged into the default branch ([fdf4a00](https://github.com/0Miles/vscode-ging-git-view/commit/fdf4a002331ed40f484ee4fb221778764e5e8dc4))
* commit-graph webview UI & styling ([7824be6](https://github.com/0Miles/vscode-ging-git-view/commit/7824be6d4d8cbd06d749294512782d386012b87a))
* extension host & native Source Control integration ([8662ec2](https://github.com/0Miles/vscode-ging-git-view/commit/8662ec24e7bfe6c29fbe4cf23c658d43d3b7272f))
* Git backend — history queries, actions & utilities ([caedea2](https://github.com/0Miles/vscode-ging-git-view/commit/caedea2d6099a35eda948216e1e39006772a659c))
* introduce gitClient based on simple-git ([#13](https://github.com/0Miles/vscode-ging-git-view/issues/13)) ([d402f18](https://github.com/0Miles/vscode-ging-git-view/commit/d402f181cfabfd472bf910db5fe331f197d25c4b))
* **scm:** add graph button on the focused repository row ([8622bf6](https://github.com/0Miles/vscode-ging-git-view/commit/8622bf69812a0d2a5f74ea246e492796d5e15693))
* Traditional & Simplified Chinese localization ([9807c48](https://github.com/0Miles/vscode-ging-git-view/commit/9807c48698ada765f83f1f5c5bb1fdc9be1c5cbe))


### Bug Fixes

* **avatars:** drop inherited hardcoded GitLab token, make it a user setting ([a09bf8d](https://github.com/0Miles/vscode-ging-git-view/commit/a09bf8db3c3bc17efc442d6cd762ec6ee215b2cc))
* **branches:** correct the unmerged-changes report and its docs ([9574c67](https://github.com/0Miles/vscode-ging-git-view/commit/9574c676d8a0130122472add40bfaf12a457b556))
* **branches:** keep one-line answers in a plain dialog ([55ec9cd](https://github.com/0Miles/vscode-ging-git-view/commit/55ec9cd67e1cddd326ac6298bb2507ce870b0ca7))
* **branches:** repair the layout of the unmerged-changes dialog ([cb9f5cd](https://github.com/0Miles/vscode-ging-git-view/commit/cb9f5cd322de1aa27a8b89675b09f3c9386e5954))
* escape HTML in git output before rendering  ([#42](https://github.com/0Miles/vscode-ging-git-view/issues/42)) ([6df298b](https://github.com/0Miles/vscode-ging-git-view/commit/6df298bf98c6dcf390abc9752f421ad0d57478be))
* extension not activating in devcontainer ([81f4fca](https://github.com/0Miles/vscode-ging-git-view/commit/81f4fcac6d2dc76565e83c401231274b8a20ed10))
* extension test regression after i18n support ([#37](https://github.com/0Miles/vscode-ging-git-view/issues/37)) ([1351fcb](https://github.com/0Miles/vscode-ging-git-view/commit/1351fcb7483697b08ce27310facfc4a53f2161ff))
* **l10n:** complete missing translations and add CI validation ([#39](https://github.com/0Miles/vscode-ging-git-view/issues/39)) ([8cf46e5](https://github.com/0Miles/vscode-ging-git-view/commit/8cf46e588a95f80cefe2ad2b0ba9a84a8a39d053))
* **l10n:** lead Chinese menu labels with the action ([8a1d39a](https://github.com/0Miles/vscode-ging-git-view/commit/8a1d39a3e70a9eaf121b99076c3a5938fc536e8d))
* prevent star activation event ([258c184](https://github.com/0Miles/vscode-ging-git-view/commit/258c184715a8109306f6a7b4a9e2457c7bf10a6d))
* remove information message ([#15](https://github.com/0Miles/vscode-ging-git-view/issues/15)) ([f5b0582](https://github.com/0Miles/vscode-ging-git-view/commit/f5b0582d18bd1258fd1d7b231ab3a0b95a48553f)), closes [#14](https://github.com/0Miles/vscode-ging-git-view/issues/14)
* **tests:** restore LANG env var after branch tests ([24d836a](https://github.com/0Miles/vscode-ging-git-view/commit/24d836a4c9aed0ff01128983591227108ff70214))
* **test:** use longer timeout in workspaceWatcher deduplication test ([dfeb865](https://github.com/0Miles/vscode-ging-git-view/commit/dfeb865da7894b36a23b1f3aa6b351fdb7f8f1be))

## 0.1.0

Initial release of **GING**.
