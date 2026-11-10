import * as vscode from "vscode";

import type { Clipboard, L10n, Opener, Prompts, Storage } from "@ging/core/host/ports";
import { type Config, config } from "@ging/vscode/config";
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
      // Git is blocked on the answer; a box that vanished on a focus change
      // would leave it waiting for one that can no longer be given.
      ignoreFocusOut: true
    })
};

/** `openCommitDiff` opens in the editor group the settings name. */
export function createVscodeOpener(
  settings: Pick<Config, "openNewTabEditorGroup"> = config
): Opener {
  return {
    openFile: (path) =>
      vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path), { preview: true }),
    // Through the diff document provider, which resolves to
    // `git show <commit>:<path>`.
    openFileAtRevision: ({ repo, filePath, commitHash }) =>
      vscode.commands.executeCommand("vscode.open", encodeDiffDocUri(repo, filePath, commitHash), {
        preview: true
      }),
    diffWithWorking: ({ repo, filePath, commitHash }, workingPath, title) =>
      vscode.commands.executeCommand(
        "vscode.diff",
        encodeDiffDocUri(repo, filePath, commitHash),
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
    openExternalUrl: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    openScmView: () => void vscode.commands.executeCommand("workbench.view.scm")
  };
}

export const vscodeClipboard: Clipboard = {
  writeText: (text) => vscode.env.clipboard.writeText(text)
};

export const vscodeL10n: L10n = { t: (key, ...args) => l10nModule.t(key, ...args) };

/** The extension's two Mementos, and its global storage folder. */
export function vscodeStorage(context: vscode.ExtensionContext): Storage {
  return {
    workspace: context.workspaceState,
    global: context.globalState,
    globalStoragePath: context.globalStoragePath
  };
}
