import * as vscode from "vscode";

import type { Prompts, Storage } from "@ging/core/host/ports";

// The VS Code side of the host ports (see `@ging/core/host/ports`): each a
// forward to the VS Code call that does the job.

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

/** The extension's two Mementos, and its global storage folder. */
export function vscodeStorage(context: vscode.ExtensionContext): Storage {
  return {
    workspace: context.workspaceState,
    global: context.globalState,
    globalStoragePath: context.globalStoragePath
  };
}
