import * as vscode from "vscode";

// Minimal type declarations for VSCode's built-in `vscode.git` extension API (version 1).
// Mirrors the surface we actually consume from extensions/git/src/api/git.d.ts in microsoft/vscode.
// We deliberately under-declare — fields we don't use are omitted.

/** A repository's Source Control view selection state (`Repository.ui`). `selected` is true while
 *  the repo is selected/visible in the native Source Control view; `onDidChange` fires on flip. */
export type RepositoryUIState = {
  readonly selected: boolean;
  readonly onDidChange: vscode.Event<void>;
};

export type BuiltinRepository = {
  readonly rootUri: vscode.Uri;
  readonly ui: RepositoryUIState;
};

export type BuiltinGitApi = {
  readonly repositories: BuiltinRepository[];
  readonly onDidOpenRepository: vscode.Event<BuiltinRepository>;
  readonly onDidCloseRepository: vscode.Event<BuiltinRepository>;
};

type GitExtensionExports = {
  enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): BuiltinGitApi;
};

/**
 * Acquire the built-in git extension's API. Returns `null` when the extension is
 * disabled, missing, or hasn't reported `enabled === true` yet — callers should
 * subscribe via `onBuiltinGitEnabled` to be notified later.
 */
export async function tryAcquireBuiltinGitApi(): Promise<BuiltinGitApi | null> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) return null;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports.enabled) return null;
  return exports.getAPI(1);
}

/**
 * Subscribe to "git extension just became enabled" — useful for late-binding our
 * repo tracking when the user toggles the built-in git extension on.
 */
export function onBuiltinGitEnabled(handler: () => void): vscode.Disposable {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) return new vscode.Disposable(() => {});
  if (!ext.isActive) {
    let cancelled = false;
    void ext.activate().then(() => {
      if (cancelled) return;
      if (ext.exports.enabled) handler();
    });
    return new vscode.Disposable(() => {
      cancelled = true;
    });
  }
  return ext.exports.onDidChangeEnablement((enabled) => {
    if (enabled) handler();
  });
}
