import * as vscode from "vscode";

import type { Storage } from "@ging/core/host/ports";

// The VS Code side of the host ports (see `@ging/core/host/ports`): each a
// forward to the VS Code call that does the job.

/** The extension's two Mementos, and its global storage folder. */
export function vscodeStorage(context: vscode.ExtensionContext): Storage {
  return {
    workspace: context.workspaceState,
    global: context.globalState,
    globalStoragePath: context.globalStoragePath
  };
}
