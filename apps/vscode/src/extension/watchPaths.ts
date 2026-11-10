import * as vscode from "vscode";

import type { WatchPath } from "@ging/core/backend/queries/gitDirs";

/** Watch each `glob` under its `base` with VS Code's file watcher, calling
 *  `onChange` on every create, change or delete. */
export function watchPaths(paths: WatchPath[], onChange: () => void): vscode.Disposable {
  const watchers = paths.map(({ base, glob }) =>
    vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(base), glob)
    )
  );
  return vscode.Disposable.from(
    ...watchers.flatMap((w) => [
      w.onDidCreate(onChange),
      w.onDidChange(onChange),
      w.onDidDelete(onChange)
    ]),
    ...watchers
  );
}
