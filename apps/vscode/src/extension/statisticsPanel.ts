import * as vscode from "vscode";

import type { Statistics } from "@/backend/queries/loadStatistics";
import * as l10n from "@/l10n";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function wrap(body: string): string {
  // No scripts and no external resources — only inline styles — so the CSP can
  // be tight.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
    h2 { font-size: 1.05em; margin: 18px 0 8px; }
    .note { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .authors { display: flex; flex-direction: column; gap: 3px; max-width: 720px; }
    .row { display: flex; align-items: center; gap: 8px; }
    .row .name { flex: 0 0 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .barWrap { flex: 1 1 auto; background: var(--vscode-input-background); border-radius: 3px; }
    .row .bar { height: 12px; border-radius: 3px; background: var(--vscode-charts-blue, #4daafc); min-width: 2px; }
    .row .count { flex: 0 0 110px; text-align: right; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    table.heat { border-collapse: collapse; }
    table.heat th { font-weight: normal; color: var(--vscode-descriptionForeground); font-size: 0.75em; padding: 1px 2px; }
    table.heat th.wd { text-align: right; padding-right: 6px; }
    table.heat td { width: 13px; height: 13px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); background-color: var(--vscode-charts-blue, #4daafc); }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export function renderStatisticsHtml(stats: Statistics): string {
  if (stats.total === 0) {
    return wrap(`<p class="note">${escapeHtml(l10n.t("stats.empty"))}</p>`);
  }
  const weekdays = l10n.t("stats.weekdays").split(",");

  const maxCount = stats.byAuthor[0]?.count ?? 1;
  const authorRows = stats.byAuthor
    .map(
      (a) => `<div class="row">
      <div class="name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
      <div class="barWrap"><div class="bar" style="width:${((a.count / maxCount) * 100).toFixed(2)}%"></div></div>
      <div class="count">${a.count} (${a.percent.toFixed(1)}%)</div>
    </div>`
    )
    .join("");

  const maxCell = Math.max(1, ...stats.heatmap.flat());
  let heat = '<table class="heat"><thead><tr><th></th>';
  for (let h = 0; h < 24; h++) heat += `<th>${h}</th>`;
  heat += "</tr></thead><tbody>";
  for (let d = 0; d < 7; d++) {
    heat += `<tr><th class="wd">${escapeHtml(weekdays[d] ?? String(d))}</th>`;
    for (let h = 0; h < 24; h++) {
      const count = stats.heatmap[d][h];
      const intensity = count === 0 ? 0 : 0.15 + 0.85 * (count / maxCell);
      heat += `<td title="${count}" style="opacity:${intensity.toFixed(3)}"></td>`;
    }
    heat += "</tr>";
  }
  heat += "</tbody></table>";

  const note = stats.capped
    ? `<p class="note">${escapeHtml(l10n.t("stats.basedOn", String(stats.limit)))}</p>`
    : "";

  return wrap(`<h2>${escapeHtml(l10n.t("stats.authors"))}</h2>
    <div class="authors">${authorRows}</div>
    <h2>${escapeHtml(l10n.t("stats.activity"))}</h2>
    ${heat}
    ${note}`);
}

// Reuse a single statistics panel rather than stacking one per invocation.
let statsPanel: vscode.WebviewPanel | undefined;

/** Open (or refresh) the read-only statistics panel (pure HTML/CSS, no scripts). */
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
  statsPanel.webview.html = renderStatisticsHtml(stats);
}
