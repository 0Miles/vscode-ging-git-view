import * as vscode from "vscode";

import { getNonce } from "@ging/core/backend/utils/nonce";
import { buildGraphViewState } from "@ging/core/extension/graphViewState";
import { ExtensionState } from "@ging/core/extensionState";
import { buildExtensionUri } from "@ging/vscode/backend/utils/uri";
import { Config } from "@ging/vscode/config";
import * as l10n from "@ging/vscode/l10n";
import { escapeJsonForHtml } from "@ging/webview/utils/html";
import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";
import { buildWebviewMarkup } from "@ging/webview/webviewMarkup";

import { RepoManager } from "./repoManager";

export function buildWebviewHtml(opts: {
  webview: vscode.Webview;
  config: Config;
  extensionPath: string;
  extensionState: ExtensionState;
  repoManager: RepoManager;
}): { html: string; isGraphLoaded: boolean } {
  const { webview, config, extensionPath, extensionState, repoManager } = opts;
  const nonce = getNonce();
  const l10nStrings = getWebviewLocalizedStrings(l10n.t);
  const viewState = buildGraphViewState({ config, repoSource: repoManager, extensionState });

  const numRepos = Object.keys(viewState.repos).length;
  let colorVars = "",
    colorParams = "";
  for (let i = 0; i < viewState.graphColours.length; i++) {
    colorVars += "--git-graph-color" + i + ":" + viewState.graphColours[i] + "; ";
    colorParams += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ");} ";
  }

  const mediaUri = (file: string) =>
    webview.asWebviewUri(buildExtensionUri(extensionPath, "media", file));
  const compiledOutputUri = (file: string) =>
    webview.asWebviewUri(buildExtensionUri(extensionPath, "out", file));

  let body: string;
  if (numRepos > 0) {
    body = `<body style="${colorVars}">
		${buildWebviewMarkup(l10nStrings)}
		<script nonce="${nonce}">var viewState = ${escapeJsonForHtml(viewState)};</script>
		<script nonce="${nonce}">var l10n = ${escapeJsonForHtml(l10nStrings)};</script>
		<script src="${compiledOutputUri("web.min.js")}"></script>
		</body>`;
  } else {
    body = `<body class="unableToLoad" style="${colorVars}">
		<h2>${l10nStrings.unableToLoadGitGraph}</h2>
		<p>${l10nStrings.noGitRepository}</p>
		<p>${l10nStrings.subfolderHint}</p>
		<p>${l10nStrings.noGit}</p>
		</body>`;
  }

  const html = `<!DOCTYPE html>
	<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src data:;">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<link rel="stylesheet" type="text/css" href="${mediaUri("main.css")}">
			<title>${l10n.t("outputChannel.text")}</title>
			<style>${colorParams}"</style>
		</head>
		${body}
	</html>`;

  return { html, isGraphLoaded: numRepos > 0 };
}
