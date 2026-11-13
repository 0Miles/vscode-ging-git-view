import type { GitGraphViewState } from "@ging/shared/types";
import { escapeHtml, escapeJsonForHtml } from "@ging/webview/utils/html";
import type { LocalizedStrings } from "@ging/webview/webviewL10n";
import { buildWebviewMarkup } from "@ging/webview/webviewMarkup";

import { bodyClassOf, type Theme } from "./theme";

/** The files the page loads, relative to it; the main process serves exactly
 *  these from the app's `out/` (see `main.ts`). */
export const PAGE_ASSETS = { stylesheet: "main.css", script: "web.js" } as const;

/** Why a page shows no graph: a heading, and a line under it. */
export type Notice = { title: string; detail: string };

/** What a page shows: a graph, or in its place a notice saying why there is
 *  none — `null` when nothing was asked for, which is a page left empty. */
export type PageContent =
  | {
      graph: {
        viewState: GitGraphViewState;
        l10n: LocalizedStrings;
        /** Allows the two inline scripts that hand the bundle its globals. */
        nonce: string;
      };
    }
  | { notice: Notice | null };

/** Each graph colour as a variable on `<body>`, and the rules that hand a
 *  `data-color` its colour, as the VS Code host writes them. */
function graphColourStyles(colours: string[]): { variables: string; rules: string } {
  return {
    variables: colours.map((colour, i) => `--git-graph-color${i}: ${colour};`).join(" "),
    rules: colours
      .map((_, i) => `[data-color="${i}"]{--git-graph-color:var(--git-graph-color${i});}`)
      .join(" ")
  };
}

/**
 * The page a desktop window opens: the theme on `<html>` and `<body>` as VS Code
 * would have put it, and the desktop entry's bundle (ADR-0031). The theme is in
 * the markup, not applied afterwards by the preload, because the bundle reads
 * the variables as it starts and the preload runs before `<html>` exists.
 *
 * The first `<style>` stands in for the defaults VS Code gives every webview's
 * `<body>`, which `main.css` relies on and does not repeat.
 *
 * A graph page also carries what the graph boots with: its markup, and the
 * `viewState` and `l10n` globals. Which kind a page is, graph or notice, is
 * written on `<html>` as `data-ging-page`, and the bundle starts the graph by
 * it (`desktop/main.ts`).
 */
export function buildDesktopPage(theme: Theme, content: PageContent = { notice: null }): string {
  const style = Object.entries(theme.variables)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  const bodyClass = bodyClassOf(theme.kind);
  const graph = "graph" in content ? content.graph : null;
  const notice = "notice" in content ? content.notice : null;

  let scriptSrc = "'self'";
  let colourRules = "";
  let body: string;
  if (graph !== null) {
    const colours = graphColourStyles(graph.viewState.graphColours);
    scriptSrc = `'self' 'nonce-${graph.nonce}'`;
    colourRules = colours.rules;
    body = `<body class="${bodyClass}" style="${escapeHtml(colours.variables)}">
${buildWebviewMarkup(graph.l10n)}
<script nonce="${graph.nonce}">var viewState = ${escapeJsonForHtml(graph.viewState)};</script>
<script nonce="${graph.nonce}">var l10n = ${escapeJsonForHtml(graph.l10n)};</script>`;
  } else if (notice !== null) {
    body = `<body class="${bodyClass} unableToLoad">
<h2>${escapeHtml(notice.title)}</h2>
<p>${escapeHtml(notice.detail)}</p>`;
  } else {
    body = `<body class="${bodyClass}">`;
  }

  // The kind stated, not left for the bundle to infer from what is missing.
  return `<!DOCTYPE html>
<html lang="en" data-ging-page="${graph !== null ? "graph" : "notice"}" style="${escapeHtml(style)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src ${scriptSrc}; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" type="text/css" href="${PAGE_ASSETS.stylesheet}">
<style>body { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); }</style>
<style>${colourRules}</style>
<title>GING</title>
</head>
${body}
<script src="${PAGE_ASSETS.script}"></script>
</body>
</html>`;
}
