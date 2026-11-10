import * as vscode from "vscode";

import type { DiffSide } from "@ging/core/extension/commitDiff";
import type { Clipboard, HostStorage, L10n, Opener, Prompts } from "@ging/core/host/ports";
import type { Config } from "@ging/vscode/config";
import { encodeDiffDocUri } from "@ging/vscode/diffDocProvider";
import { openCommitDiff } from "@ging/vscode/extension/openCommitDiff";
import * as l10nModule from "@ging/vscode/l10n";

// The VS Code side of the host ports (see `@ging/core/host/ports`). Each is a
// forward to the one VS Code call that does the job; the ports whose VS Code
// implementation is an object the extension already has — `config`, the
// logger, the repo manager, the file watcher — are those objects, passed as
// they are.

export const vscodePrompts: Prompts = {
  showInformation: (message) => void vscode.window.showInformationMessage(message),
  showWarning: (message) => void vscode.window.showWarningMessage(message),
  showError: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
  pickSaveLocation: async ({ saveLabel, filters, defaultPath }) =>
    (
      await vscode.window.showSaveDialog({
        saveLabel,
        filters,
        defaultUri: vscode.Uri.file(defaultPath)
      })
    )?.fsPath,
  input: ({ prompt, placeholder, password }) =>
    vscode.window.showInputBox({
      placeHolder: placeholder,
      prompt,
      password,
      // The port's prompt stays up until it is answered (see `Prompts.input`).
      ignoreFocusOut: true
    })
};

/** `openCommitDiff` opens in the editor group the settings name. */
export function createVscodeOpener(settings: Pick<Config, "openNewTabEditorGroup">): Opener {
  // Through the diff document provider, which resolves to
  // `git show <commit>:<path>`.
  const revisionUri = ({ repo, filePath, commit }: DiffSide) =>
    encodeDiffDocUri(repo, filePath, commit);
  const openPreview = (uri: vscode.Uri) =>
    vscode.commands.executeCommand("vscode.open", uri, { preview: true });
  return {
    openFile: (path) => openPreview(vscode.Uri.file(path)),
    openFileAtRevision: (file) => openPreview(revisionUri(file)),
    diffWithWorking: (left, workingPath, title) =>
      vscode.commands.executeCommand(
        "vscode.diff",
        revisionUri(left),
        vscode.Uri.file(workingPath),
        title,
        { preview: true }
      ),
    openCommitDiff: (request) => openCommitDiff(request, settings.openNewTabEditorGroup()),
    openMergeEditor: (repo, filePath) => {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(repo), filePath);
      // The built-in git extension's 3-way merge editor; fall back to a plain
      // open if it (or the command) isn't available.
      void Promise.resolve(vscode.commands.executeCommand("git.openMergeEditor", uri)).then(
        undefined,
        () => vscode.commands.executeCommand("vscode.open", uri)
      );
    },
    openTerminal: (cwd, name) => vscode.window.createTerminal({ cwd, name }).show(),
    openExternalUrl: (url) => void vscode.env.openExternal(vscode.Uri.parse(url))
  };
}

export const vscodeClipboard: Clipboard = {
  writeText: (text) => vscode.env.clipboard.writeText(text)
};

export const vscodeL10n: L10n = { t: l10nModule.t };

/** The extension's two Mementos, and its global storage folder. */
export function vscodeStorage(context: vscode.ExtensionContext): HostStorage {
  return {
    workspace: context.workspaceState,
    global: context.globalState,
    globalStoragePath: context.globalStoragePath
  };
}
