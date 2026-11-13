import type { Theme } from "./theme";

/** The files the page loads, relative to it; the main process serves exactly
 *  these from the app's `out/` (see `main.ts`). */
export const PAGE_ASSETS = { stylesheet: "main.css", script: "web.js" } as const;

/**
 * The page a desktop window opens: the theme on `<html>` and `<body>` as VS Code
 * would have put it, and the desktop entry's bundle (ADR-0031). The theme is in
 * the markup, not applied afterwards by the preload, because the bundle reads
 * the variables as it starts and the preload runs before `<html>` exists.
 *
 * The `<style>` stands in for the defaults VS Code gives every webview's
 * `<body>`, which `main.css` relies on and does not repeat.
 *
 * What the graph boots with — `viewState`, `l10n`, the markup it looks up by
 * id — is not here yet: it comes with the first graph (#388).
 */
export function buildDesktopPage(theme: Theme): string {
  const style = Object.entries(theme.variables)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  return `<!DOCTYPE html>
<html lang="en" style="${escapeAttribute(style)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" type="text/css" href="${PAGE_ASSETS.stylesheet}">
<style>body { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); }</style>
<title>GING</title>
</head>
<body class="${theme.bodyClass}">
<script src="${PAGE_ASSETS.script}"></script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
