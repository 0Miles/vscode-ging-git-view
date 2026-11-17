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

/** The panel's words, in the app's language, its shortcut the platform's. */
export function workingTreeStrings(
  l10n: Pick<L10n, "t">,
  platform: NodeJS.Platform
): WorkingTreeStrings {
  const t = (key: string, ...args: string[]) => l10n.t(`desktop.workingTree.${key}`, ...args);
  return {
    title: t("title"),
    close: t("close"),
    message: t("message", platform === "darwin" ? "⌘Enter" : "Ctrl+Enter"),
    commit: t("commit"),
    staged: t("staged"),
    unstaged: t("unstaged"),
    conflicted: t("conflicted"),
    stage: t("stage"),
    stageAll: t("stageAll"),
    unstage: t("unstage"),
    unstageAll: t("unstageAll"),
    clean: t("clean"),
    // Filled in by the panel, which knows the count.
    more: t("more", "{0}"),
    submodule: t("submodule"),
    changes: {
      added: t("change.added"),
      modified: t("change.modified"),
      deleted: t("change.deleted"),
      renamed: t("change.renamed"),
      copied: t("change.copied"),
      typeChanged: t("change.typeChanged"),
      untracked: t("change.untracked"),
      conflicted: t("change.conflicted")
    },
    amend: t("amend"),
    amendCommit: t("amendCommit"),
    signOff: t("signOff"),
    signOffDetail: t("signOffDetail"),
    cannotAmend: {
      unborn: t("cannotAmend.unborn"),
      merge: t("cannotAmend.merge"),
      rebase: t("cannotAmend.rebase"),
      cherrypick: t("cannotAmend.cherrypick"),
      revert: t("cannotAmend.revert")
    },
    // Filled in by the panel, which knows the branches.
    amendPushed: t("amendPushed", "{0}"),
    amendPushedConfirm: t("amendPushedConfirm"),
    identityUnknown: t("identityUnknown")
  };
}

/** Answer one of the panel's requests: the working tree after it, why it
 *  failed, if it did, and the panel's `strings`. */
export async function answerWorkingTree(
  service: WorkingTreeService,
  strings: WorkingTreeStrings,
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
        return service.commit({
          message: request.message,
          amend: request.amend === true,
          signOff: request.signOff === true,
          rewritePushed: request.rewritePushed === true
        });
    }
  })();
  return {
    command: "workingTreeStatus",
    request: request.command,
    ...answer,
    strings
  };
}
