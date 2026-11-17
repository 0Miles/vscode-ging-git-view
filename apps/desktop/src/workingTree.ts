/* A Tab's working tree panel (#403), as the main process answers it: each of
 * the panel's requests handed to core's working tree service, and its answer
 * put back in the panel's words. Apart from Electron, so the tests drive it
 * as the page does. */

import type { WorkingTreeService } from "@ging/core/extension/workingTreeService";
import type { L10n } from "@ging/core/host/ports";
import type {
  WorkingTreeRequest,
  WorkingTreeStatusMessage,
  WorkingTreeStrings
} from "@ging/webview/desktop/workingTree/protocol";

/** The panel's words, in the app's language. */
export function workingTreeStrings(l10n: Pick<L10n, "t">): WorkingTreeStrings {
  const t = (key: string) => l10n.t(`desktop.workingTree.${key}`);
  return {
    title: t("title"),
    close: t("close"),
    message: t("message"),
    commit: t("commit"),
    staged: t("staged"),
    unstaged: t("unstaged"),
    conflicted: t("conflicted"),
    stage: t("stage"),
    stageAll: t("stageAll"),
    unstage: t("unstage"),
    unstageAll: t("unstageAll"),
    clean: t("clean"),
    changes: {
      added: t("change.added"),
      modified: t("change.modified"),
      deleted: t("change.deleted"),
      renamed: t("change.renamed"),
      copied: t("change.copied"),
      typeChanged: t("change.typeChanged"),
      untracked: t("change.untracked"),
      conflicted: t("change.conflicted")
    }
  };
}

/** Answer one of the panel's requests: the working tree after it, and why it
 *  failed, if it did. */
export async function answerWorkingTree(
  service: WorkingTreeService,
  l10n: Pick<L10n, "t">,
  request: WorkingTreeRequest
): Promise<WorkingTreeStatusMessage> {
  const answer = await (() => {
    switch (request.command) {
      case "workingTreeLoad":
        return service.status();
      case "workingTreeStage":
        return service.stage(request.paths);
      case "workingTreeUnstage":
        return service.unstage(request.paths);
      case "workingTreeCommit":
        return service.commit(request.message);
    }
  })();
  return {
    command: "workingTreeStatus",
    request: request.command,
    ...answer,
    strings: workingTreeStrings(l10n)
  };
}
