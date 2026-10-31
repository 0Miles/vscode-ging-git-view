# Changelog

## [0.8.0](https://github.com/0Miles/vscode-ging-git-view/compare/v0.7.0...v0.8.0) (2026-10-31)


### Features

* **graph:** carry a copy of a dragged branch label under the pointer ([#208](https://github.com/0Miles/vscode-ging-git-view/issues/208)) ([5055779](https://github.com/0Miles/vscode-ging-git-view/commit/5055779af5c93d49adb7abd908b7569df0f4e857))
* **graph:** move a branch by dragging its label onto a commit ([468c19f](https://github.com/0Miles/vscode-ging-git-view/commit/468c19fab61e2afbfca43f22593a51a89b12dc17))
* **graph:** move a branch by dragging its label onto a commit ([#208](https://github.com/0Miles/vscode-ging-git-view/issues/208)) ([dc93666](https://github.com/0Miles/vscode-ging-git-view/commit/dc936660bcd6e33db953ff0e28f52b9e98fb7c2b))
* **graph:** open Reset when the checked-out branch is dropped ([#208](https://github.com/0Miles/vscode-ging-git-view/issues/208)) ([eccf57b](https://github.com/0Miles/vscode-ging-git-view/commit/eccf57bf90958e13d8e786d6e245136f9101d11f))
* **graph:** show the progress dialog while a dragged branch moves ([#208](https://github.com/0Miles/vscode-ging-git-view/issues/208)) ([2dd16a6](https://github.com/0Miles/vscode-ging-git-view/commit/2dd16a6395378b0654e606d3d35f00c2d9ea4857))
* **reset:** offer Keep in the Reset dialog ([1b6ff29](https://github.com/0Miles/vscode-ging-git-view/commit/1b6ff297f76b388da338f1b81564d21d631c2c47))
* **reset:** offer Keep in the Reset dialog ([9332887](https://github.com/0Miles/vscode-ging-git-view/commit/933288769331b930981c3d33a2b79f02e05bd9a7)), closes [#207](https://github.com/0Miles/vscode-ging-git-view/issues/207)
* **webview:** freeze the control bar and column headers at the top ([a983a61](https://github.com/0Miles/vscode-ging-git-view/commit/a983a61c03d07459f011773bbe48eac61a86f331))
* **webview:** freeze the control bar and column headers at the top ([675bb40](https://github.com/0Miles/vscode-ging-git-view/commit/675bb4018d8817c55ea90e4957640f836420a943)), closes [#206](https://github.com/0Miles/vscode-ging-git-view/issues/206)
* **webview:** make the dialog's file list and buttons keyboard-operable ([#145](https://github.com/0Miles/vscode-ging-git-view/issues/145)) ([d815fd0](https://github.com/0Miles/vscode-ging-git-view/commit/d815fd0b61bdb7692f580a7ea52f35f303d16f76))
* **webview:** make the dialog's file list and buttons keyboard-operable ([#145](https://github.com/0Miles/vscode-ging-git-view/issues/145)) ([86b99e1](https://github.com/0Miles/vscode-ging-git-view/commit/86b99e18d30b56db80d555e184ae097b433d5182))


### Bug Fixes

* clear the 15 raw issues filed during the gtw-76 run ([70416e5](https://github.com/0Miles/vscode-ging-git-view/commit/70416e5daef99292133aee2bfc689977390f682f))
* dedupe stash rows that --reflog already lists ([#105](https://github.com/0Miles/vscode-ging-git-view/issues/105)) ([273b433](https://github.com/0Miles/vscode-ging-git-view/commit/273b4334816f4857c9efa4cd9d245190a011c3c7))
* dedupe stash rows that --reflog already lists ([#105](https://github.com/0Miles/vscode-ging-git-view/issues/105)) ([6cbe796](https://github.com/0Miles/vscode-ging-git-view/commit/6cbe7965fadedf519ff021babcdfecfe93e7decf))
* dedupe stash rows that --reflog already lists ([#105](https://github.com/0Miles/vscode-ging-git-view/issues/105)) ([c7f6a42](https://github.com/0Miles/vscode-ging-git-view/commit/c7f6a42fddb70240e72f0da1a8ddd065fb6af6b4))
* **graph:** centre a progress dialog that has no buttons ([#208](https://github.com/0Miles/vscode-ging-git-view/issues/208)) ([92b067a](https://github.com/0Miles/vscode-ging-git-view/commit/92b067a60fc2dccd79b07d1863b77b44838f7516))
* **graph:** cover commit order and remote branches defaults too ([#211](https://github.com/0Miles/vscode-ging-git-view/issues/211)) ([56f38df](https://github.com/0Miles/vscode-ging-git-view/commit/56f38dfc9c75a1318eadbc6d3134ea91c0191674))
* **graph:** draw only the first parent when history follows first parents ([f184a13](https://github.com/0Miles/vscode-ging-git-view/commit/f184a135c83877fc75af9f3f257680267ae32c44))
* **graph:** draw only the first parent when history follows first parents ([#205](https://github.com/0Miles/vscode-ging-git-view/issues/205)) ([f0b8dec](https://github.com/0Miles/vscode-ging-git-view/commit/f0b8dec199ef81c2a0a3a64557f01118668fb83f))
* **graph:** drop Dismiss from a moving branch's progress dialog ([#208](https://github.com/0Miles/vscode-ging-git-view/issues/208)) ([a2b6883](https://github.com/0Miles/vscode-ging-git-view/commit/a2b68830b9e3addd42ff836b3b8bb0b9056aa7dd))
* **graph:** hold a branch drag's confirmation to what it said ([#208](https://github.com/0Miles/vscode-ging-git-view/issues/208)) ([f3f8df2](https://github.com/0Miles/vscode-ging-git-view/commit/f3f8df2a49e3cd5ca11a1975dc369845de3a1ba7))
* **graph:** keep the line to a loaded second parent in first-parent mode ([#205](https://github.com/0Miles/vscode-ging-git-view/issues/205)) ([ef7d463](https://github.com/0Miles/vscode-ging-git-view/commit/ef7d463eb4f1e45d35b12522cd4d6cb250271d1e))
* **graph:** reload when a Repository Setting default changes in VS Code settings ([#211](https://github.com/0Miles/vscode-ging-git-view/issues/211)) ([dcffcdb](https://github.com/0Miles/vscode-ging-git-view/commit/dcffcdbcab938490e32bb744d47df9db45b6abd1))
* **graph:** reload when a Repository Setting default changes in VS Code settings ([#211](https://github.com/0Miles/vscode-ging-git-view/issues/211)) ([bc128fd](https://github.com/0Miles/vscode-ging-git-view/commit/bc128fd269ae1e26d131c01285f59b0a24b0a852))
* **graph:** reload when a Repository Setting default changes in VS Code's settings ([#211](https://github.com/0Miles/vscode-ging-git-view/issues/211)) ([f543b6e](https://github.com/0Miles/vscode-ging-git-view/commit/f543b6e62117237bbec9504bc7249a5541a26f6c))
* **harness:** answer the webview's load requests with their own token ([#235](https://github.com/0Miles/vscode-ging-git-view/issues/235)) ([663a9d9](https://github.com/0Miles/vscode-ging-git-view/commit/663a9d9396b907e73afe74f9bb1b53aa14331468))
* **l10n:** fix graph, zh-TW description and mixed-width punctuation ([#156](https://github.com/0Miles/vscode-ging-git-view/issues/156)) ([aa4369d](https://github.com/0Miles/vscode-ging-git-view/commit/aa4369de0a39006c11f72c7cc63d15c4bb41d57a))
* **l10n:** fix graph, zh-TW description and mixed-width punctuation ([#156](https://github.com/0Miles/vscode-ging-git-view/issues/156)) ([8c8c2a6](https://github.com/0Miles/vscode-ging-git-view/commit/8c8c2a67bc15355a2e802c54e85b01af94f834c2))
* **l10n:** keep 选取 in the zh-CN Source Control selection setting ([#156](https://github.com/0Miles/vscode-ging-git-view/issues/156)) ([03f71f7](https://github.com/0Miles/vscode-ging-git-view/commit/03f71f7b12f01a5d3eac70d8445c2fdbce60ca4f))
* **l10n:** repair zh-TW/zh-CN wording and add a punctuation check ([#155](https://github.com/0Miles/vscode-ging-git-view/issues/155), [#156](https://github.com/0Miles/vscode-ging-git-view/issues/156)) ([4fb4780](https://github.com/0Miles/vscode-ging-git-view/commit/4fb478066075c7f141876dba3a17ebfb1bd3f2c2))
* **l10n:** restore label/tab wording over-replaced by tag ([#155](https://github.com/0Miles/vscode-ging-git-view/issues/155)) ([d03eedb](https://github.com/0Miles/vscode-ging-git-view/commit/d03eedbcb18825d992539b40268e82bc08b291d7))
* **l10n:** restore label/tab wording over-replaced by tag ([#155](https://github.com/0Miles/vscode-ging-git-view/issues/155)) ([a2b23aa](https://github.com/0Miles/vscode-ging-git-view/commit/a2b23aabde4b78255e26197658326d0b8b6d9ec7))
* **l10n:** word the zh-CN editor tab as 选项卡 ([#155](https://github.com/0Miles/vscode-ging-git-view/issues/155)) ([de2e620](https://github.com/0Miles/vscode-ging-git-view/commit/de2e6201b0bc996b154718cd2e39846ce4ae8959))
* **l10n:** word the zh-CN Source Control selection setting in mainland terms ([#156](https://github.com/0Miles/vscode-ging-git-view/issues/156)) ([294d3d3](https://github.com/0Miles/vscode-ging-git-view/commit/294d3d32d3ccbed06f06580c1c04c0e93ca9fec2))
* never splice a stash that --reflog will list ([#105](https://github.com/0Miles/vscode-ging-git-view/issues/105)) ([bdafd28](https://github.com/0Miles/vscode-ging-git-view/commit/bdafd287bbdd009aa6f1d75f3fcc54e4ad44ddfc))
* **push:** explain a lease refused for stale info ([#201](https://github.com/0Miles/vscode-ging-git-view/issues/201)) ([7523846](https://github.com/0Miles/vscode-ging-git-view/commit/752384606f3edf719288567410fada663cff8d8d))
* **push:** explain a lease refused for stale info ([#201](https://github.com/0Miles/vscode-ging-git-view/issues/201)) ([a0d6825](https://github.com/0Miles/vscode-ging-git-view/commit/a0d68253b49d8872f7e09096a76b1f36d5a68bf6))
* **push:** report every remote's failure for tag pushes and remote deletes ([#264](https://github.com/0Miles/vscode-ging-git-view/issues/264)) ([346e70f](https://github.com/0Miles/vscode-ging-git-view/commit/346e70f5146bb52b902d7c206c3e44d85a2a034d))
* **push:** report every remote's refusal, after every remote has answered ([#264](https://github.com/0Miles/vscode-ging-git-view/issues/264)) ([e93f232](https://github.com/0Miles/vscode-ging-git-view/commit/e93f232af089966995905aea0d602e311b848067))
* **push:** type batch results per action and explain stale-info lease refusals ([#202](https://github.com/0Miles/vscode-ging-git-view/issues/202), [#201](https://github.com/0Miles/vscode-ging-git-view/issues/201)) ([a2feb5f](https://github.com/0Miles/vscode-ging-git-view/commit/a2feb5f594414be04569818bdfb404ffe31bfc94))
* **push:** word the stale-info explanation in each bundle's own terms ([#201](https://github.com/0Miles/vscode-ging-git-view/issues/201)) ([b73134a](https://github.com/0Miles/vscode-ging-git-view/commit/b73134ab724aafaf1f923e9ef9e3af4a8237c39c))
* **reset:** describe Keep as moving the branch and keeping changes ([0a51681](https://github.com/0Miles/vscode-ging-git-view/commit/0a516814f5357cdc0d72f3e0894e31b03d7b557c)), closes [#207](https://github.com/0Miles/vscode-ging-git-view/issues/207)
* **webview:** bind form dialogs to the repository state at consent ([#132](https://github.com/0Miles/vscode-ging-git-view/issues/132)) ([3875152](https://github.com/0Miles/vscode-ging-git-view/commit/3875152be59a4919f3d4b618ac9548e4e122eea0))
* **webview:** bind form dialogs to the repository state at consent ([#132](https://github.com/0Miles/vscode-ging-git-view/issues/132)) ([1bccbd4](https://github.com/0Miles/vscode-ging-git-view/commit/1bccbd471b264293ced78d4e644fe102b7a4a641))
* **webview:** bind the graph table's chip, header and resize handlers within #commitTable ([#166](https://github.com/0Miles/vscode-ging-git-view/issues/166)) ([9891ba7](https://github.com/0Miles/vscode-ging-git-view/commit/9891ba77aa9d4d2dc1e79ea31a951e84b31d6586))
* **webview:** bind the graph table's chip, header and resize handlers within #commitTable ([#166](https://github.com/0Miles/vscode-ging-git-view/issues/166)) ([eb87fb7](https://github.com/0Miles/vscode-ging-git-view/commit/eb87fb78a0d9020e4e773ce42eb5882ea7e5a846))
* **webview:** bind the rest of the form dialogs to the moment of consent ([#132](https://github.com/0Miles/vscode-ging-git-view/issues/132)) ([55d6584](https://github.com/0Miles/vscode-ging-git-view/commit/55d658444267563e98fd7ec67394fb67f5af8959))
* **webview:** bring a docked CDV's commit out from under the panel ([#231](https://github.com/0Miles/vscode-ging-git-view/issues/231)) ([cbc7acf](https://github.com/0Miles/vscode-ging-git-view/commit/cbc7acf8b95df3e3c05af0f0da1a4db1a1c5ddb2))
* **webview:** bring a docked CDV's commit out from under the panel ([#231](https://github.com/0Miles/vscode-ging-git-view/issues/231)) ([7d077d3](https://github.com/0Miles/vscode-ging-git-view/commit/7d077d3abaab7f1a529944cc3e6a087196e73ab6))
* **webview:** centre Find's match when the CDV it opened cannot load ([#256](https://github.com/0Miles/vscode-ging-git-view/issues/256)) ([e4cbf67](https://github.com/0Miles/vscode-ging-git-view/commit/e4cbf67fc8b4df3aeaab931c5c5067719ede0879))
* **webview:** centre the Commit Details View on its measured block ([#216](https://github.com/0Miles/vscode-ging-git-view/issues/216)) ([4b15368](https://github.com/0Miles/vscode-ging-git-view/commit/4b15368d185c8479580b774a3a04877e60fdd71a))
* **webview:** centre the Commit Details View on its measured block ([#216](https://github.com/0Miles/vscode-ging-git-view/issues/216)) ([85137f3](https://github.com/0Miles/vscode-ging-git-view/commit/85137f3b3f63d9aea6210d5f7db265abebd9bd5c))
* **webview:** centre the Commit Details View on its measured block ([#216](https://github.com/0Miles/vscode-ging-git-view/issues/216)) ([10b31e5](https://github.com/0Miles/vscode-ging-git-view/commit/10b31e5d860213a52a42e9b4627f1dfd7bedafdf))
* **webview:** claim the busy indicator for a menu commit-order change ([#245](https://github.com/0Miles/vscode-ging-git-view/issues/245)) ([f27edb1](https://github.com/0Miles/vscode-ging-git-view/commit/f27edb1fc6de278b39e32de73844e3728d758a8c))
* **webview:** close a context menu anchored in the graph before a redraw ([#126](https://github.com/0Miles/vscode-ging-git-view/issues/126)) ([d1a2fd0](https://github.com/0Miles/vscode-ging-git-view/commit/d1a2fd0a7980aca502c0659739d96915cef4388b))
* **webview:** close a context menu anchored in the graph before a redraw ([#126](https://github.com/0Miles/vscode-ging-git-view/issues/126)) ([77d5194](https://github.com/0Miles/vscode-ging-git-view/commit/77d51949a2f0876b8ee6b8a9c26df6a18e05aac3))
* **webview:** close a context menu anchored in the graph before a redraw ([#126](https://github.com/0Miles/vscode-ging-git-view/issues/126)) ([d779e9a](https://github.com/0Miles/vscode-ging-git-view/commit/d779e9a32d5bedbf31dcf5fbade603331615c448))
* **webview:** close an open context menu when a dialog takes the screen ([#218](https://github.com/0Miles/vscode-ging-git-view/issues/218)) ([13e3eee](https://github.com/0Miles/vscode-ging-git-view/commit/13e3eee72387ecd3d9c72adedbeefbb4e5e4c5bd))
* **webview:** fill ref names into l10n templates with fillTemplate ([#264](https://github.com/0Miles/vscode-ging-git-view/issues/264)) ([8564012](https://github.com/0Miles/vscode-ging-git-view/commit/85640123eaa3f377907ef7caafea20e567cd5126))
* **webview:** hold the page still behind a modal dialog ([#230](https://github.com/0Miles/vscode-ging-git-view/issues/230)) ([c811557](https://github.com/0Miles/vscode-ging-git-view/commit/c811557d29cab20306cea745cbc445adeeedb066))
* **webview:** hold the page still behind a modal dialog ([#230](https://github.com/0Miles/vscode-ging-git-view/issues/230)) ([365c7af](https://github.com/0Miles/vscode-ging-git-view/commit/365c7af5ab00b1936ec0143394af136c2fe75cb1))
* **webview:** keep cleanup refetch and scan results off a replacing dialog ([#127](https://github.com/0Miles/vscode-ging-git-view/issues/127)) ([7db2771](https://github.com/0Miles/vscode-ging-git-view/commit/7db27714ab1c9725ad52c8f7308009622414b95a))
* **webview:** keep Find in place when a pending step's branch is gone ([#246](https://github.com/0Miles/vscode-ging-git-view/issues/246)) ([4705c5a](https://github.com/0Miles/vscode-ging-git-view/commit/4705c5a4c59ee8338b2bbb309d43b09e8b966b7f))
* **webview:** keep focus off &lt;body&gt; on head chips and CDV links across a redraw ([#251](https://github.com/0Miles/vscode-ging-git-view/issues/251)) ([2c9ed2f](https://github.com/0Miles/vscode-ging-git-view/commit/2c9ed2fa34fe6f496bea5b23d2dc5c33b6767eb0))
* **webview:** keep focus on the frozen header row from scrolling the page ([9ff0cf7](https://github.com/0Miles/vscode-ging-git-view/commit/9ff0cf79adbc744a3ca7aedad00a2f92eab2fb36)), closes [#206](https://github.com/0Miles/vscode-ging-git-view/issues/206)
* **webview:** keep rows clear of the docked Commit Details View when scrolling ([#217](https://github.com/0Miles/vscode-ging-git-view/issues/217)) ([81e71cb](https://github.com/0Miles/vscode-ging-git-view/commit/81e71cb9cb1be19d1ab7187d382fdb58e6893d11))
* **webview:** keep rows clear of the docked Commit Details View when scrolling ([#217](https://github.com/0Miles/vscode-ging-git-view/issues/217)) ([5334363](https://github.com/0Miles/vscode-ging-git-view/commit/53343634317288f47d312d5c5dba4963eb2045d5))
* **webview:** keep rows clear of the docked Commit Details View when scrolling ([#217](https://github.com/0Miles/vscode-ging-git-view/issues/217)) ([86723ea](https://github.com/0Miles/vscode-ging-git-view/commit/86723ead4f453232848c51b6ea82f35aaa112b83))
* **webview:** keep the CDV file list's tab stop across a redraw ([#129](https://github.com/0Miles/vscode-ging-git-view/issues/129)) ([090586e](https://github.com/0Miles/vscode-ging-git-view/commit/090586eb76a8003f6ec3eb6e88d93ba3a033a807))
* **webview:** keep the CDV file list's tab stop across a redraw ([#129](https://github.com/0Miles/vscode-ging-git-view/issues/129)) ([f556614](https://github.com/0Miles/vscode-ging-git-view/commit/f5566140287b7f79d0ca3aac50f5de31983e5e72))
* **webview:** keep the CDV file list's tab stop across a redraw ([#129](https://github.com/0Miles/vscode-ging-git-view/issues/129)) ([8ce1a18](https://github.com/0Miles/vscode-ging-git-view/commit/8ce1a1852ecdcd2e734a7d3103149de644f7aaba))
* **webview:** keep the commit row in sight when centring a tall panel ([#216](https://github.com/0Miles/vscode-ging-git-view/issues/216)) ([5d56c19](https://github.com/0Miles/vscode-ging-git-view/commit/5d56c19c750ca237fd0a108e1c4ce2e1d35ae0ad))
* **webview:** let a confirmed Find step supersede a pending one ([#247](https://github.com/0Miles/vscode-ging-git-view/issues/247)) ([2608cc6](https://github.com/0Miles/vscode-ging-git-view/commit/2608cc604214268129ef0ddc025a861efac72925))
* **webview:** let a later Find press supersede a pending step ([#247](https://github.com/0Miles/vscode-ging-git-view/issues/247)) ([d373375](https://github.com/0Miles/vscode-ging-git-view/commit/d373375179ad1ffff40dd6aad0db9879acc7afd6))
* **webview:** make dialogs modal end to end ([#127](https://github.com/0Miles/vscode-ging-git-view/issues/127), [#134](https://github.com/0Miles/vscode-ging-git-view/issues/134), [#230](https://github.com/0Miles/vscode-ging-git-view/issues/230), [#141](https://github.com/0Miles/vscode-ging-git-view/issues/141), [#145](https://github.com/0Miles/vscode-ging-git-view/issues/145)) ([06eeee9](https://github.com/0Miles/vscode-ging-git-view/commit/06eeee9c83e5be45f2be7b0393fa90f6ec494e20))
* **webview:** make modal dialogs modal to the keyboard ([#141](https://github.com/0Miles/vscode-ging-git-view/issues/141)) ([556ca57](https://github.com/0Miles/vscode-ging-git-view/commit/556ca572d9d0a69041ec9110004fd67dcb661d94))
* **webview:** make modal dialogs modal to the keyboard ([#141](https://github.com/0Miles/vscode-ging-git-view/issues/141)) ([f8af71f](https://github.com/0Miles/vscode-ging-git-view/commit/f8af71f480f3ca4373e7a18c47b0198b0a856d75))
* **webview:** measure CDV scroll-into-view and bring docked commits out from under the panel ([#228](https://github.com/0Miles/vscode-ging-git-view/issues/228), [#231](https://github.com/0Miles/vscode-ging-git-view/issues/231)) ([a8f508d](https://github.com/0Miles/vscode-ging-git-view/commit/a8f508d3f6dea425a23ca75cdf4b5267fc83390e))
* **webview:** measure the CDV's up/down scroll on screen ([#228](https://github.com/0Miles/vscode-ging-git-view/issues/228)) ([76756b1](https://github.com/0Miles/vscode-ging-git-view/commit/76756b1920c43356e238ef077a84c4a0a583c8b0))
* **webview:** measure the CDV's up/down scroll on screen ([#228](https://github.com/0Miles/vscode-ging-git-view/issues/228)) ([3dcc013](https://github.com/0Miles/vscode-ging-git-view/commit/3dcc013993c458cc323a751f55515447688559f9))
* **webview:** owe Find's late step dialogs and drop debts from a left repository ([#243](https://github.com/0Miles/vscode-ging-git-view/issues/243), [#269](https://github.com/0Miles/vscode-ging-git-view/issues/269)) ([fb58bf5](https://github.com/0Miles/vscode-ging-git-view/commit/fb58bf5706e923065aaa256c9b0a10b70fa31da2))
* **webview:** owe late host answers instead of writing over the user's dialog ([#243](https://github.com/0Miles/vscode-ging-git-view/issues/243)) ([cb271af](https://github.com/0Miles/vscode-ging-git-view/commit/cb271affbfa5b05a5642adc1555ed62d214d24ae))
* **webview:** pay an owed batch summary only if it was owed when the slot emptied ([#134](https://github.com/0Miles/vscode-ging-git-view/issues/134)) ([7e79853](https://github.com/0Miles/vscode-ging-git-view/commit/7e79853c2c1bc466f0591ea4ea0c93f769ff6266))
* **webview:** push to the remotes a form showed, by name ([#132](https://github.com/0Miles/vscode-ging-git-view/issues/132)) ([a664046](https://github.com/0Miles/vscode-ging-git-view/commit/a664046563307eae9971405239d881c294eadb52))
* **webview:** put the dialog backing above every other layer ([#218](https://github.com/0Miles/vscode-ging-git-view/issues/218)) ([8cd04ed](https://github.com/0Miles/vscode-ging-git-view/commit/8cd04ed4008abf595d57748252440fe7f196789f))
* **webview:** put the dialog backing above every other layer ([#218](https://github.com/0Miles/vscode-ging-git-view/issues/218)) ([99e8816](https://github.com/0Miles/vscode-ging-git-view/commit/99e88162ce0d9288700bda20421319e93608fb7f))
* **webview:** put the dialog backing above every other layer ([#218](https://github.com/0Miles/vscode-ging-git-view/issues/218)) ([e8ad1a6](https://github.com/0Miles/vscode-ging-git-view/commit/e8ad1a6afe7f83ee5b5f1aa63abb614664d1be04))
* **webview:** queue owed batch summaries so a second abandoned run cannot overwrite the first ([#253](https://github.com/0Miles/vscode-ging-git-view/issues/253)) ([f7aeaad](https://github.com/0Miles/vscode-ging-git-view/commit/f7aeaad376da0a7b31923707d9f403bd6d52e93d))
* **webview:** refuse a rebase --onto whose repo moved under it ([#132](https://github.com/0Miles/vscode-ging-git-view/issues/132)) ([35d21db](https://github.com/0Miles/vscode-ging-git-view/commit/35d21db0d71123a4e9527df0b57ee09ed33ad93f))
* **webview:** release busy loads on throw; add Find, busy, CDV and direct-write vocabulary ([#138](https://github.com/0Miles/vscode-ging-git-view/issues/138), [#118](https://github.com/0Miles/vscode-ging-git-view/issues/118), [#81](https://github.com/0Miles/vscode-ging-git-view/issues/81), [#157](https://github.com/0Miles/vscode-ging-git-view/issues/157)) ([ba80e5b](https://github.com/0Miles/vscode-ging-git-view/commit/ba80e5bbe523f5f4516f5ef3ebd6cc38a39a84d7))
* **webview:** release load callbacks when a handler or close-out throws ([#138](https://github.com/0Miles/vscode-ging-git-view/issues/138)) ([8d9f773](https://github.com/0Miles/vscode-ging-git-view/commit/8d9f773848ed8d3b42a05a05bc0c4cd62d9f945c))
* **webview:** release load callbacks when a handler or close-out throws ([#138](https://github.com/0Miles/vscode-ging-git-view/issues/138)) ([70078f2](https://github.com/0Miles/vscode-ging-git-view/commit/70078f2ef49efbe311530bf8f2ef3ce1bd7fc23b))
* **webview:** release the load gate when a request fails to send ([#241](https://github.com/0Miles/vscode-ging-git-view/issues/241)) ([942ffdd](https://github.com/0Miles/vscode-ging-git-view/commit/942ffdd3dbcd0224d88f34d289cd4072c4d667b2))
* **webview:** remember the CDV file tab stop under the panel's drawn identity ([#268](https://github.com/0Miles/vscode-ging-git-view/issues/268)) ([c659862](https://github.com/0Miles/vscode-ging-git-view/commit/c6598625a70077d30aec788de8a897fe819161f0))
* **webview:** retry a waiting ref action when a commit request fails to send ([#241](https://github.com/0Miles/vscode-ging-git-view/issues/241)) ([e4b9f21](https://github.com/0Miles/vscode-ging-git-view/commit/e4b9f21bb7b6d9892b374700bab5a3507d48a144))
* **webview:** run the pending ref action even when a close-out throws ([#138](https://github.com/0Miles/vscode-ging-git-view/issues/138)) ([ca046bc](https://github.com/0Miles/vscode-ging-git-view/commit/ca046bc414bfdddefe1fe9cf9bb8ae17bc317cf2))
* **webview:** scope the uncommitted-row rewrite and keep hidden column widths ([#261](https://github.com/0Miles/vscode-ging-git-view/issues/261)) ([f6b6c8a](https://github.com/0Miles/vscode-ging-git-view/commit/f6b6c8a7d9ab8b870d780acc9be742680416302f))
* **webview:** scroll once when Find opens the CDV, and keep docked space across a swap ([#256](https://github.com/0Miles/vscode-ging-git-view/issues/256)) ([5347592](https://github.com/0Miles/vscode-ging-git-view/commit/53475922de97a1d643204219df6adc08998b219e))
* **webview:** tell a dialog's dismissal hook whether the user or the system closed it ([#134](https://github.com/0Miles/vscode-ging-git-view/issues/134)) ([876fa02](https://github.com/0Miles/vscode-ging-git-view/commit/876fa026db1d28c6ebdc9497a6ef9927afc58b37))
* **webview:** tell a dialog's dismissal hook whether the user or the system closed it ([#134](https://github.com/0Miles/vscode-ging-git-view/issues/134)) ([2ee69d2](https://github.com/0Miles/vscode-ging-git-view/commit/2ee69d2c217a6536991780f493217c60d9ab8124))
* **webview:** tell only the refusal when an owed force-delete offer outlives a repo switch ([#243](https://github.com/0Miles/vscode-ging-git-view/issues/243)) ([f867cfd](https://github.com/0Miles/vscode-ging-git-view/commit/f867cfdfac02e4b6de43230f74b65372052bff49))
* **webview:** tie progress dialog answers to the dialog that asked ([#127](https://github.com/0Miles/vscode-ging-git-view/issues/127)) ([b1a7239](https://github.com/0Miles/vscode-ging-git-view/commit/b1a72394213c5106f0e98795cc93f1e29ab125fa))
* **webview:** tie progress dialog answers to the dialog that asked ([#127](https://github.com/0Miles/vscode-ging-git-view/issues/127)) ([ef02572](https://github.com/0Miles/vscode-ging-git-view/commit/ef025724967a61a88aa2c532ad3205fd54dad22f))

## [0.7.0](https://github.com/0Miles/vscode-ging-git-view/compare/v0.6.1...v0.7.0) (2026-09-27)


### Features

* **webview:** a Repository Settings dialog behind a toolbar gear ([2cfc426](https://github.com/0Miles/vscode-ging-git-view/commit/2cfc426329f4def6391d738afdb237b6c57733c6)), closes [#183](https://github.com/0Miles/vscode-ging-git-view/issues/183) [#175](https://github.com/0Miles/vscode-ging-git-view/issues/175)
* **webview:** a Repository Settings drawer behind a toolbar gear ([ed82dde](https://github.com/0Miles/vscode-ging-git-view/commit/ed82dde9b4157523605280355e673a6eb0a8d040))
* **webview:** Repository Settings slides out of the gear, and applies as it changes ([8f87f57](https://github.com/0Miles/vscode-ging-git-view/commit/8f87f57be30ef57c005e8cc560b9aa1395ae0fc1))


### Bug Fixes

* **l10n:** call first-parent-only what it shows, the mainline ([26fd886](https://github.com/0Miles/vscode-ging-git-view/commit/26fd886892ce8004e9a3765a18105bf7ba5ea2d9))
* **push:** drop doubled emphasis in the zh lease-refused copy ([b97e3f3](https://github.com/0Miles/vscode-ging-git-view/commit/b97e3f3fad8524b99adc1ae9f66ef2baeb318225)), closes [#198](https://github.com/0Miles/vscode-ging-git-view/issues/198)
* **push:** explain a batch lease refused for an unintegrated remote tip ([31e0f06](https://github.com/0Miles/vscode-ging-git-view/commit/31e0f06f067439d1243dd0f058833ac94434487e)), closes [#199](https://github.com/0Miles/vscode-ging-git-view/issues/199) [#193](https://github.com/0Miles/vscode-ging-git-view/issues/193)
* **push:** force-with-lease only over a remote tip that was integrated ([798c674](https://github.com/0Miles/vscode-ging-git-view/commit/798c6746571b4b49359334ec32a6a1cb993cad4f))
* **push:** only force-with-lease over a remote tip that was integrated ([4c1b16e](https://github.com/0Miles/vscode-ging-git-view/commit/4c1b16ed084c7d8baf5ca5b331c4777d2295a0b6)), closes [#198](https://github.com/0Miles/vscode-ging-git-view/issues/198) [#193](https://github.com/0Miles/vscode-ging-git-view/issues/193)


### Performance Improvements

* land [#190](https://github.com/0Miles/vscode-ging-git-view/issues/190) on main — two quadratic layout walks, and a dispatch that checks itself ([8568c15](https://github.com/0Miles/vscode-ging-git-view/commit/8568c15daccdc212e52f6c956999a156859113c8))

## [0.6.1](https://github.com/0Miles/vscode-ging-git-view/compare/v0.6.0...v0.6.1) (2026-09-04)


### Bug Fixes

* **git-client:** build the client before the setters commit to it ([1eb280c](https://github.com/0Miles/vscode-ging-git-view/commit/1eb280c6c2c99907586eb5acc9d8152f2b5ed5b1))
* give GING a terminal state for a Current repository that is gone ([6fe851f](https://github.com/0Miles/vscode-ging-git-view/commit/6fe851fa6f80bfe583b78159e6b3cae1199e243c))
* **l10n:** git refuses, it does not "may refuse" ([5f4fded](https://github.com/0Miles/vscode-ging-git-view/commit/5f4fdedc186289c4616c17a2a96a922e0362f114))
* **repo-boot:** seed the graph with a repository it can actually open ([6eeb465](https://github.com/0Miles/vscode-ging-git-view/commit/6eeb465dbd30693eb9ddd7e251d615ab43e78e4a))
* **repo-selection:** bind the git client before selectRepo commits to it ([9aa58de](https://github.com/0Miles/vscode-ging-git-view/commit/9aa58de877cc1898cf7caf3315d3cbd363303ae8))
* **repo-selection:** refuse a repository that is empty or gone ([9e8f90c](https://github.com/0Miles/vscode-ging-git-view/commit/9e8f90c78c447f66660573d5fba323c9efba5c64))
* **repo-state:** resolve the persisted repo path before anything reads it ([084af45](https://github.com/0Miles/vscode-ging-git-view/commit/084af45eaad6f50f0b44578d6ca0d70e109af17f))
* the graph must not land on a repository nobody chose ([a1f63bc](https://github.com/0Miles/vscode-ging-git-view/commit/a1f63bc9f0e0ecc58d3b67e5d8f62d2a2da0e313))
* **ui:** polish branch cleanup feedback ([bdc0a3d](https://github.com/0Miles/vscode-ging-git-view/commit/bdc0a3dc5c976636a928fa53fc4b515e95f3384c))
* **ui:** polish branch cleanup feedback ([2ccdc39](https://github.com/0Miles/vscode-ging-git-view/commit/2ccdc39ab462870be30cda63ed58b6439fe15362))
* **webview:** "no repository" is an answer, not a repository path ([cbfb28b](https://github.com/0Miles/vscode-ging-git-view/commit/cbfb28bd90872652d423e656a70aa8068ea35c36))
* **webview:** a navigation must settle what it abandoned, and ignore what predates it ([c1dbaca](https://github.com/0Miles/vscode-ging-git-view/commit/c1dbacafbfcf245b696e4bf08daa39bc698439fc))
* **webview:** close the holes the first pass at the no-repository state left ([1116f7f](https://github.com/0Miles/vscode-ging-git-view/commit/1116f7f4ec749ba687a18068b1bdd2bd59da5172))
* **webview:** hiding a remote is a navigation, not a droppable refresh ([3742412](https://github.com/0Miles/vscode-ging-git-view/commit/37424126d43503811089f773979034165e5ca5c7))
* **webview:** navigation abandons the load in flight ([#84](https://github.com/0Miles/vscode-ging-git-view/issues/84)) ([2cbbe3f](https://github.com/0Miles/vscode-ging-git-view/commit/2cbbe3f23adc95d397deb79f95714d9d08672ec2))
* **webview:** navigation abandons the load in flight ([#84](https://github.com/0Miles/vscode-ging-git-view/issues/84)) ([a07b58c](https://github.com/0Miles/vscode-ging-git-view/commit/a07b58c5a19d0b3b1f5029b0f52700c5f3cca5ba))
* **webview:** navigation abandons the load in flight ([#84](https://github.com/0Miles/vscode-ging-git-view/issues/84)) ([9c24e9c](https://github.com/0Miles/vscode-ging-git-view/commit/9c24e9c9d8278eb2bdb9d0ed417acfda43eeed55))

## [0.6.0](https://github.com/0Miles/vscode-ging-git-view/compare/v0.5.0...v0.6.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* **rebase:** replay both commits the compared range names
* **rebase:** the `ging-git-view.contextMenuActions.commit.rebaseOnto` setting key is removed. The range rebase is now the same menu entry as the plain one and is hidden by `contextMenuActions.commit.rebase`. A `rebaseOnto` key left in user settings is ignored. Removing it also resolves the contradiction #172 left behind, where the plain entry could emit `rebaseOnto` while `commit.rebaseOnto` was switched off.

### Features

* **rebase:** choose the git command from which commits are kept ([84be267](https://github.com/0Miles/vscode-ging-git-view/commit/84be267a49640af8b476eadc8ef6bcb0a6d35e2e))
* **rebase:** list the commits a rebase will replay, each tickable ([5ae24ca](https://github.com/0Miles/vscode-ging-git-view/commit/5ae24ca6ec59df6103f521149889373668699c01))
* **rebase:** replay both commits the compared range names ([90b46ad](https://github.com/0Miles/vscode-ging-git-view/commit/90b46add7c9a7e4f7f5d94c4112dc60d1ff62cf1))
* **rebase:** the compared range takes over the existing rebase entries ([1a94e02](https://github.com/0Miles/vscode-ging-git-view/commit/1a94e022ffbd5778d6a622ff48d936c04d3d0675))


### Bug Fixes

* **l10n:** translate the View Diff actions in zh-tw and zh-cn ([6e8dace](https://github.com/0Miles/vscode-ging-git-view/commit/6e8dace70cf07d4a907e82f922201c0878623542))
* **l10n:** translate the View Diff actions in zh-tw and zh-cn ([8dec46e](https://github.com/0Miles/vscode-ging-git-view/commit/8dec46e8b0eefb91f712746a03f151d70682911e))
* **rebase:** keep the replay checklist's promises when the range holds a merge ([48c8122](https://github.com/0Miles/vscode-ging-git-view/commit/48c81221fbf22d3954614c9943cedaf1ee90d8bb))
* **rebase:** let the command preview speak for the dialog ([a29252e](https://github.com/0Miles/vscode-ging-git-view/commit/a29252ef3564d864739d6bce951d712dcea91338))
* **rebase:** print the ref name the rebase runs against, not its HTML ([83189a4](https://github.com/0Miles/vscode-ging-git-view/commit/83189a46a19f40d641be80663220df81b94d431a))

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
