import * as vscode from "vscode";

import { getNonce } from "@/backend/utils/nonce";
import { buildExtensionUri } from "@/backend/utils/path";
import { Config } from "@/config";
import { ExtensionState } from "@/extensionState";
import * as l10n from "@/l10n";
import { GitGraphViewState } from "@/types";

import { RepoManager } from "./repoManager";
import { getWebviewLocalizedStrings } from "./webviewL10n";
import { buildWebviewMarkup } from "./webviewMarkup";

/**
 * Safely escape JSON for embedding in HTML script tags.
 * Prevents XSS by escaping characters that could break out of script context.
 */
function escapeJsonForHtml(obj: object): string {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function buildWebviewHtml(opts: {
  webview: vscode.Webview;
  config: Config;
  extensionPath: string;
  extensionState: ExtensionState;
  repoManager: RepoManager;
}): { html: string; isGraphLoaded: boolean } {
  const { webview, config, extensionPath, extensionState, repoManager } = opts;
  const nonce = getNonce();
  const l10nStrings = getWebviewLocalizedStrings();
  const viewState: GitGraphViewState = {
    autoCenterCommitDetailsView: config.autoCenterCommitDetailsView(),
    commitDetailsViewLocation: config.commitDetailsViewLocation(),
    referenceLabelAlignment: config.referenceLabelAlignment(),
    combineLocalAndRemoteBranchLabels: config.combineLocalAndRemoteBranchLabels(),
    dialogDeleteBranchForceDelete: config.dialogDeleteBranchForceDelete(),
    dialogCherryPickNoCommit: config.dialogCherryPickNoCommit(),
    dialogAddTagType: config.dialogAddTagType(),
    dialogCreateBranchCheckOut: config.dialogCreateBranchCheckOut(),
    dialogMergeNoFastForward: config.dialogMergeNoFastForward(),
    dialogMergeSquash: config.dialogMergeSquash(),
    dialogResetMode: config.dialogResetMode(),
    dialogMemory: extensionState.getDialogMemory(),
    contextMenuActionsVisibility: config.contextMenuActionsVisibility(),
    customBranchGlobPatterns: config.customBranchGlobPatterns(),
    customEmojiShortcodeMappings: config.customEmojiShortcodeMappings(),
    dateFormat: config.dateFormat(),
    dateCustomFormat: config.dateCustomFormat(),
    defaultColumnVisibility: config.defaultColumnVisibility(),
    enhancedAccessibility: config.enhancedAccessibility(),
    fetchAvatars: config.fetchAvatars() && extensionState.isAvatarStorageAvailable(),
    fileTreeCompactFolders: config.fileTreeCompactFolders(),
    fileViewType: config.fileViewType(),
    graphColours: config.graphColours(),
    graphStyle: config.graphStyle(),
    initialLoadCommits: config.initialLoadCommits(),
    issueLinkingRegex: config.issueLinkingRegex(),
    issueLinkingUrl: config.issueLinkingUrl(),
    keybindings: config.keybindings(),
    lastActiveRepo: extensionState.getLastActiveRepo(),
    loadMoreAutomatically: config.loadMoreAutomatically(),
    loadMoreCount: config.loadMoreCount(),
    markdown: config.markdown(),
    muteCommitsNotAncestorsOfHead: config.muteCommitsNotAncestorsOfHead(),
    muteMergeCommits: config.muteMergeCommits(),
    signCommits: config.signCommits(),
    onLoadScrollToHead: config.onLoadScrollToHead(),
    referenceInputSpaceSubstitution: config.referenceInputSpaceSubstitution(),
    repos: repoManager.getRepos(),
    scmMultiRepoSelection: config.scmMultiRepoSelection(),
    showCurrentBranchByDefault: config.showCurrentBranchByDefault(),
    uncommittedChangesAtHead: config.uncommittedChangesAtHead(),
    showSpecificBranches: config.showSpecificBranches(),
    showRemoteBranches: config.showRemoteBranches(),
    showTags: config.showTags()
  };

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
