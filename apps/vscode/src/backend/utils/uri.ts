import * as path from "node:path";

import * as vscode from "vscode";

import { getPathFromStr } from "@ging/core/backend/utils/path";

// The two path helpers that take or make a `vscode.Uri`; the plain-string ones
// live in @ging/core/backend/utils/path.

export function getPathFromUri(uri: vscode.Uri) {
  return getPathFromStr(uri.fsPath);
}

export function buildExtensionUri(extensionPath: string, ...pathComps: string[]) {
  return vscode.Uri.file(path.join(extensionPath, ...pathComps));
}
