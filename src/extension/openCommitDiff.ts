import * as vscode from "vscode";

import type { EditorGroup } from "@/config";
import { encodeDiffDocUri } from "@/diffDocProvider";
import * as l10n from "@/l10n";

import { type CommitDiffRequest, commitDiffView } from "./commitDiff";

/**
 * Open a commit's change to a file in VS Code's diff editor (see
 * `commitDiffView` for what each side shows), in `editorGroup`, revealing the
 * asked line if any. The graph panel and the blame hover both open diffs
 * through here. Resolves to whether VS Code opened it.
 */
export function openCommitDiff(
  request: CommitDiffRequest,
  editorGroup: EditorGroup
): Promise<boolean> {
  const { left, right, title, reveal } = commitDiffView(request, {
    addedIn: (abbrevHash) => l10n.t("diff.addedIn", abbrevHash),
    deletedIn: (abbrevHash) => l10n.t("diff.deletedIn", abbrevHash)
  });
  // EditorGroup values are vscode.ViewColumn enum keys (Active, Beside, One..Nine).
  const viewColumn = vscode.ViewColumn[editorGroup];
  const options: vscode.TextDocumentShowOptions = { preview: true, viewColumn };
  if (reveal !== null) options.selection = new vscode.Range(reveal, 0, reveal, 0);
  return new Promise<boolean>((resolve) => {
    vscode.commands
      .executeCommand(
        "vscode.diff",
        encodeDiffDocUri(left.repo, left.filePath, left.commit),
        encodeDiffDocUri(right.repo, right.filePath, right.commit),
        title,
        options
      )
      .then(
        () => resolve(true),
        () => resolve(false)
      );
  });
}
