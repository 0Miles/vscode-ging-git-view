# Changelog

## [0.5.0](https://github.com/0Miles/vscode-ging-git-view/compare/v0.4.0...v0.5.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **webview:** load-more-on-scroll, fixed and on by default ([#90](https://github.com/0Miles/vscode-ging-git-view/issues/90))

### Features

* rebase a selected commit range onto another commit, and configurable pull request providers ([#62](https://github.com/0Miles/vscode-ging-git-view/issues/62)) ([d654f19](https://github.com/0Miles/vscode-ging-git-view/commit/d654f19bd872b8b9dc13771948c1863822fd21f6))
* **webview:** load-more-on-scroll, fixed and on by default ([#90](https://github.com/0Miles/vscode-ging-git-view/issues/90)) ([b58af65](https://github.com/0Miles/vscode-ging-git-view/commit/b58af65cd39ab947d56800783c4e57bb6c5ebe20))


### Bug Fixes

* **adr:** fail the check on an ADR reference written as a path ([5814725](https://github.com/0Miles/vscode-ging-git-view/commit/5814725ff8886069b0debf3c3dea894dd1b726de))
* **adr:** fail the check on an ADR reference written as a path ([b803f95](https://github.com/0Miles/vscode-ging-git-view/commit/b803f9577dc0983ed153228d5cd7866b2c94d630)), closes [#59](https://github.com/0Miles/vscode-ging-git-view/issues/59)
* **branches:** arm the selection suppression only when a branch is cleared ([#66](https://github.com/0Miles/vscode-ging-git-view/issues/66)) ([2fc3f43](https://github.com/0Miles/vscode-ging-git-view/commit/2fc3f4364b323ea3bb00a36ad78924679a4562b6))
* **extension:** a repo switch gives up on the suppression's missing event ([4b4ca16](https://github.com/0Miles/vscode-ging-git-view/commit/4b4ca1666a3c503372c1efdb70f5735ae31f6e9c)), closes [#43](https://github.com/0Miles/vscode-ging-git-view/issues/43)
* **extension:** only a real repo switch gives up on the awaited event ([f6f4221](https://github.com/0Miles/vscode-ging-git-view/commit/f6f422188f85b6e9bcd0b0da461eee0785c540a7)), closes [#43](https://github.com/0Miles/vscode-ging-git-view/issues/43)
* **l10n:** say it the way a zh-CN reader would ([4df0616](https://github.com/0Miles/vscode-ging-git-view/commit/4df06161e073cb17d77aac7758b277faf74ebf04))
* **l10n:** say it the way a zh-CN reader would ([9b6b987](https://github.com/0Miles/vscode-ging-git-view/commit/9b6b987e74b7df94bdca9d110be91d559409b4c0))
* **l10n:** the load-more count is an increment, not a button's payload ([27427bc](https://github.com/0Miles/vscode-ging-git-view/commit/27427bc50fc635ca7828b7e446fb9b089cb92adc))
* **l10n:** the load-more count is an increment, not a button's payload ([3dc0cc7](https://github.com/0Miles/vscode-ging-git-view/commit/3dc0cc77c5461f6bbf3fe1599424a7a982039a4c)), closes [#75](https://github.com/0Miles/vscode-ging-git-view/issues/75)
* **tests:** the guard on a missing menu item never fired ([2153419](https://github.com/0Miles/vscode-ging-git-view/commit/215341951cd59b638ffac307f0eba3c05c51431e))
* **tests:** the guard on a missing menu item never fired ([5024091](https://github.com/0Miles/vscode-ging-git-view/commit/502409139f1e4a6a6978c612eeb0f01641217e8c)), closes [#131](https://github.com/0Miles/vscode-ging-git-view/issues/131)
* **webview:** a batch run survives losing the dialog that held its question ([#125](https://github.com/0Miles/vscode-ging-git-view/issues/125)) ([68078d2](https://github.com/0Miles/vscode-ging-git-view/commit/68078d22b952c467374119a60383b8e3b467727e))
* **webview:** close the last two ways a redraw moves the reader ([#114](https://github.com/0Miles/vscode-ging-git-view/issues/114)) ([6bfd3b1](https://github.com/0Miles/vscode-ging-git-view/commit/6bfd3b12f6ad9d11546929fd7d0262a9c2306bfa))
* **webview:** four ways the graph acted on something the user was not looking at ([9fd2a77](https://github.com/0Miles/vscode-ging-git-view/commit/9fd2a7780ed0706cd9364157b573c655adf8f07d))
* **webview:** reach the footer by keyboard, and stop the redraw laying out twice ([#123](https://github.com/0Miles/vscode-ging-git-view/issues/123)) ([69ff854](https://github.com/0Miles/vscode-ging-git-view/commit/69ff8541057db8e4d0d2be3511d14ebbc5b8cf13))
* **webview:** say the four refusals that were said in silence ([f25f55a](https://github.com/0Miles/vscode-ging-git-view/commit/f25f55a21d54e91d5f40b08266bbcf5e0bb12190)), closes [#137](https://github.com/0Miles/vscode-ging-git-view/issues/137)
* **webview:** stop the wheel widening the graph behind a dialog ([5f2f0c4](https://github.com/0Miles/vscode-ging-git-view/commit/5f2f0c48cfbe20dd034391b7cff25ad9ee4d58c0)), closes [#124](https://github.com/0Miles/vscode-ging-git-view/issues/124)
* **webview:** the dialog's commit rows are not the graph's to act on ([49ea6c6](https://github.com/0Miles/vscode-ging-git-view/commit/49ea6c6de4c2435fdf96a3a135c1918340b94ebf)), closes [#144](https://github.com/0Miles/vscode-ging-git-view/issues/144)
* **webview:** the dialog's file rows are not the panel's to act on ([bb31994](https://github.com/0Miles/vscode-ging-git-view/commit/bb31994d59f0c846c1d25a329f21699843d59a5f)), closes [#128](https://github.com/0Miles/vscode-ging-git-view/issues/128)
* **webview:** the graph's commit rows are the graph's to read as well ([faa70ba](https://github.com/0Miles/vscode-ging-git-view/commit/faa70ba0ac2464492c2ac64c071d7bd710cacd6e))
* **webview:** the graph's commit rows are the graph's to read as well ([690179c](https://github.com/0Miles/vscode-ging-git-view/commit/690179c47927bf30bff91355629d908258c2a896)), closes [#150](https://github.com/0Miles/vscode-ging-git-view/issues/150)
* **webview:** what the dialog asked about may not be what Yes acts on ([#139](https://github.com/0Miles/vscode-ging-git-view/issues/139)) ([cc6b893](https://github.com/0Miles/vscode-ging-git-view/commit/cc6b89304b6964608efc95aad2166e1f13de0b2c))

## [0.4.0](https://github.com/0Miles/vscode-ging-git-view/compare/v0.3.2...v0.4.0) (2026-08-15)


### Features

* **branches:** 清理候選 branch 的對話框 ([#40](https://github.com/0Miles/vscode-ging-git-view/issues/40)) ([0422ec9](https://github.com/0Miles/vscode-ging-git-view/commit/0422ec9686ee1fbb0e753e34cd2646bd464ce0f1))
* **graph:** reach every context menu from the keyboard ([#37](https://github.com/0Miles/vscode-ging-git-view/issues/37)) ([805b1a6](https://github.com/0Miles/vscode-ging-git-view/commit/805b1a68ca9b3fc85178a2699747d778db86d4d3))
* **webview:** report webview failures to the Output Channel ([#41](https://github.com/0Miles/vscode-ging-git-view/issues/41)) ([b6e8b15](https://github.com/0Miles/vscode-ging-git-view/commit/b6e8b150503d9f266cd4e35f91cbab56988f6927))

## [0.3.2](https://github.com/0Miles/vscode-ging-git-view/compare/v0.3.1...v0.3.2) (2026-08-11)


### Bug Fixes

* **fetch:** prune deleted remote-tracking branches by default ([#34](https://github.com/0Miles/vscode-ging-git-view/issues/34)) ([c892d8c](https://github.com/0Miles/vscode-ging-git-view/commit/c892d8c8f7f31754d724eae43e1c868ec10c97fd))
* **graph:** stop the graph panel multiplying across host restarts ([#32](https://github.com/0Miles/vscode-ging-git-view/issues/32)) ([860a047](https://github.com/0Miles/vscode-ging-git-view/commit/860a0476500ce0fefe7a88c70d379251104c117b))
* **graph:** sweep graph tabs the accumulation bug already left behind ([87cf7be](https://github.com/0Miles/vscode-ging-git-view/commit/87cf7be3aae1cbcb3e52b5023b5ebbba7c18216d))

## [0.3.1](https://github.com/0Miles/vscode-ging-git-view/compare/v0.3.0...v0.3.1) (2026-08-05)


### Bug Fixes

* **branches:** address code-review findings on the catalogue refactor ([72af9d4](https://github.com/0Miles/vscode-ging-git-view/commit/72af9d41efa5d57bf972e935a10eee085532d751))
* **graph:** gate the repo dropdown on VSCode's repo-selection mode ([021ace1](https://github.com/0Miles/vscode-ging-git-view/commit/021ace1247d22ea250bba551085a8a691e23bf21))
* **graph:** keep the focused repo in view when arrowing the dropdown ([adf96bf](https://github.com/0Miles/vscode-ging-git-view/commit/adf96bf452ab0a8f50332a4febd6655b9e75d870))
* **graph:** show a repo dropdown in the toolbar when several repos are known ([09b9d21](https://github.com/0Miles/vscode-ging-git-view/commit/09b9d21ef1008adc570df952a8da812220106244)), closes [#16](https://github.com/0Miles/vscode-ging-git-view/issues/16)
* **graph:** stop the repo title swallowing clicks and its own tooltip ([bd44c57](https://github.com/0Miles/vscode-ging-git-view/commit/bd44c576cfd1dbaed058eed94b4b538d97e64095))
* **harness:** align seeded messages with the current ResponseMessage types ([#28](https://github.com/0Miles/vscode-ging-git-view/issues/28)) ([db6986d](https://github.com/0Miles/vscode-ging-git-view/commit/db6986db232c52c353a80057111c3b6df6752749)), closes [#14](https://github.com/0Miles/vscode-ging-git-view/issues/14)
* **watcher:** stop muting the file watcher for query messages ([#27](https://github.com/0Miles/vscode-ging-git-view/issues/27)) ([b4e3aa6](https://github.com/0Miles/vscode-ging-git-view/commit/b4e3aa657ab89f788bc76baabc4710dedcb8c03a))

## [0.3.0](https://github.com/0Miles/vscode-ging-git-view/compare/v0.2.0...v0.3.0) (2026-08-03)


### Features

* **branches:** act on the whole selection in the sidebar menu ([e691493](https://github.com/0Miles/vscode-ging-git-view/commit/e69149327807b651786955b587aaae81a0e7feea))
* **graph:** dress the context menus as native ones, with icons and keyboard navigation ([1c7c716](https://github.com/0Miles/vscode-ging-git-view/commit/1c7c716afcd644039971f3f221fa15bed98a7bc4))
* **graph:** report the branch filter in the toolbar, and let it be cleared there ([70050b2](https://github.com/0Miles/vscode-ging-git-view/commit/70050b293e55cca8045746b363433ac19fbf50b0))


### Bug Fixes

* **branches:** offer the force delete a failed delete was meant to offer ([99e9d91](https://github.com/0Miles/vscode-ging-git-view/commit/99e9d91e4ab7ed2da75eb309571db3b5ad6f10b8))

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
