import * as vscode from "vscode";

import { GitRepoSet } from "@ging/shared/types";
import { AvatarManager } from "@ging/vscode/avatarManager";
import { buildExtensionUri } from "@ging/vscode/backend/utils/path";
import { Config } from "@ging/vscode/config";
import { ExtensionState } from "@ging/vscode/extensionState";
import { RepoFileWatcher } from "@ging/vscode/repoFileWatcher";

import { RepoChangeCallback, RepoManager } from "./repoManager";
import { WebviewBridge } from "./webviewBridge";
import { buildWebviewHtml } from "./webviewHtml";

export function createWebviewPanel(opts: {
  panel: vscode.WebviewPanel;
  bridge: WebviewBridge;
  config: Config;
  repoFileWatcher: RepoFileWatcher;
  extensionPath: string;
  extensionState: ExtensionState;
  avatarManager: AvatarManager;
  repoManager: RepoManager;
  onDispose: () => void;
  onPanelShown: () => void;
}) {
  const {
    panel,
    bridge,
    config,
    repoFileWatcher,
    extensionPath,
    extensionState,
    avatarManager,
    repoManager,
    onDispose,
    onPanelShown
  } = opts;

  const disposables: vscode.Disposable[] = [];
  let isGraphViewLoaded = false;
  let isPanelVisible = true;

  panel.iconPath =
    config.tabIconColourTheme() === "colour"
      ? buildExtensionUri(extensionPath, "resources", "webview-icon.svg")
      : {
          light: buildExtensionUri(extensionPath, "resources", "webview-icon-light.svg"),
          dark: buildExtensionUri(extensionPath, "resources", "webview-icon-dark.svg")
        };

  function update() {
    const result = buildWebviewHtml({
      webview: panel.webview,
      config,
      extensionPath,
      extensionState,
      repoManager
    });
    panel.webview.html = result.html;
    isGraphViewLoaded = result.isGraphLoaded;
  }

  const onReposChanged: RepoChangeCallback = (repos: GitRepoSet, numRepos: number) => {
    if (!panel.visible) return;
    if ((numRepos === 0 && isGraphViewLoaded) || (numRepos > 0 && !isGraphViewLoaded)) {
      update();
    } else {
      bridge.post({
        command: "loadRepos",
        repos,
        lastActiveRepo: repoManager.getBootRepo()
      });
    }
  };

  function dispose() {
    onDispose();
    panel.dispose();
    avatarManager.deregisterBridge();
    repoFileWatcher.stop();
    repoManager.deregisterViewCallback(onReposChanged);
    while (disposables.length) {
      const x = disposables.pop();
      if (x) x.dispose();
    }
  }

  update();
  panel.onDidDispose(() => dispose(), null, disposables);
  panel.onDidChangeViewState(
    () => {
      if (panel.visible !== isPanelVisible) {
        if (panel.visible) {
          onPanelShown();
          update();
        } else {
          repoFileWatcher.stop();
        }
        isPanelVisible = panel.visible;
      }
    },
    null,
    disposables
  );

  repoManager.registerViewCallback(onReposChanged);

  return {
    reveal(column?: vscode.ViewColumn) {
      panel.reveal(column);
    },
    dispose
  };
}

export type WebviewPanel = ReturnType<typeof createWebviewPanel>;
