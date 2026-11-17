import * as vscode from "vscode";

import type { Statistics } from "@ging/core/backend/queries/loadStatistics";
import * as l10n from "@ging/vscode/l10n";
import { renderStatisticsHtml } from "@ging/webview/statisticsMarkup";

// Reuse a single statistics panel rather than stacking one per invocation.
let statsPanel: vscode.WebviewPanel | undefined;

/** Open (or refresh) the read-only statistics panel (pure HTML/CSS, no
 *  scripts; the page is the desktop host's too, #396). */
export function showStatistics(stats: Statistics): void {
  if (statsPanel === undefined) {
    statsPanel = vscode.window.createWebviewPanel(
      "ging-git-view.statistics",
      l10n.t("stats.title"),
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    statsPanel.onDidDispose(() => {
      statsPanel = undefined;
    });
  } else {
    statsPanel.reveal(vscode.ViewColumn.Active);
  }
  statsPanel.webview.html = renderStatisticsHtml(stats, (key, ...args) => l10n.t(key, ...args));
}
