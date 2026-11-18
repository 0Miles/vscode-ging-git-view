/* A Tab's blame view (#409), as the main process answers it: the file the
 * Tab's page shows read-only (#405) offered for blame, its blame and its
 * lines' hovers read by core's file blame service, and the hovers' links run
 * — a hash copied, a line's change shown in the Tab's diff viewer (#404), a
 * commit located in its graph. The application menu's Blame File… shows the
 * working tree's copy of a file picked, blamed. Apart from Electron, so the
 * tests drive it as the page and the menu do. */

import path from "node:path";

import { abbrevCommit } from "@ging/core/backend/utils/string";
import { commitDiffView } from "@ging/core/extension/commitDiff";
import type { FileBlameService, FileBlameTarget } from "@ging/core/extension/fileBlameService";
import type { Clipboard, HostLogger, L10n, Prompts } from "@ging/core/host/ports";
import type {
  FileBlameHostMessage,
  FileBlameOffer,
  FileBlameRequest,
  FileBlameStrings
} from "@ging/webview/desktop/diff/blameProtocol";

import type { DiffSource, ShowDiff, ShowFile } from "./diffViewer";
import { pathInRepo } from "./fileHistory";

/** The blame view's words, in the app's language. */
export function fileBlameStrings(l10n: Pick<L10n, "t">): FileBlameStrings {
  return {
    toggle: l10n.t("desktop.blame.toggle"),
    blaming: l10n.t("desktop.blame.blaming"),
    failed: l10n.t("desktop.blame.failed"),
    findInGraph: l10n.t("desktop.blame.findInGraph")
  };
}

/** What `source` is to blame: a commit's file — not an index stage's (`:0`,
 *  `:1`…, anything named from `:`), which has no commit to blame it in — or
 *  the working tree's, by its path in `repo`. */
export function blameTargetOf(source: DiffSource, shownPath: string): FileBlameTarget | null {
  if ("revision" in source) {
    const { commit, filePath } = source.revision;
    return commit.startsWith(":") ? null : { filePath, revision: commit };
  }
  return { filePath: shownPath, revision: null };
}

export type FileBlameDeps = {
  service: FileBlameService;
  /** The Tab's repository. */
  repo: () => string;
  /** Its diff viewer, for a line's change. */
  showDiff: ShowDiff;
  /** Its viewer of a file, for the menu's Blame File…. */
  showFile: ShowFile;
  /** Hand its page a message. */
  post: (message: FileBlameHostMessage) => void;
  /** Select `sha` in its graph and bring it into view. */
  locate: (sha: string) => void;
  clipboard: Clipboard;
  /** A file of the repository, picked in the system's dialog opened on it;
   *  null when none was. */
  pickFile: (repo: string) => Promise<string | null>;
  /** Whether git tracks the file at `path`, in the repository. */
  isTracked: (path: string) => Promise<boolean>;
  prompts: Pick<Prompts, "showError" | "showInformation">;
  l10n: L10n;
  logger: Pick<HostLogger, "logError">;
  /** The real path of a file: `fs.promises.realpath` unless a test says. */
  realpath?: (file: string) => Promise<string>;
};

export type FileBlame = {
  /** The file `source` is about to be shown, as `shownPath`: what to offer
   *  its page to blame it by, or null when it cannot be. Whatever was offered
   *  before is let go. */
  offer(source: DiffSource, shownPath: string, show: boolean): FileBlameOffer | null;
  /** What the page asked. */
  receive(request: FileBlameRequest): Promise<void>;
  /** The application menu's Blame File…: a file picked, shown blamed. */
  pickAndShow(): Promise<void>;
  /** The instance is going: stop blaming. */
  dispose(): void;
};

export function createFileBlame(deps: FileBlameDeps): FileBlame {
  const { service, post, l10n, logger } = deps;
  /** The file offered last, by the number the page names it by; `blamed`
   *  while its page shows its blame (asked, and not let go). */
  let offered: { file: number; target: FileBlameTarget; blamed: boolean } | null = null;
  let files = 0;

  /** Whether `file` is the one offered last: nothing else is blamed. */
  const isOffered = (file: number) => offered !== null && offered.file === file;
  /** Whether `file`'s blame is shown: its hovers are waited for. */
  const isBlamed = (file: number) => isOffered(file) && offered!.blamed;

  const run = async (request: Extract<FileBlameRequest, { command: "fileBlameRun" }>) => {
    switch (request.link) {
      case "copySha": {
        const sha = service.copySha(request.arg);
        if (sha === null) return;
        await deps.clipboard.writeText(sha);
        post({
          command: "fileBlameSaid",
          file: request.file,
          text: l10n.t("blame.copiedHash", abbrevCommit(sha))
        });
        return;
      }
      case "locateCommit": {
        const sha = service.locate(request.arg);
        if (sha === null) {
          void deps.prompts.showError(l10n.t("blame.locate.failed"));
          return;
        }
        deps.locate(sha);
        return;
      }
      case "openLineChange": {
        const diff = service.lineChange(request.arg);
        const view =
          diff === null
            ? null
            : commitDiffView(diff, {
                addedIn: (abbrevHash) => l10n.t("diff.addedIn", abbrevHash),
                deletedIn: (abbrevHash) => l10n.t("diff.deletedIn", abbrevHash)
              });
        try {
          if (view === null) throw new Error("not a line's change of this repository");
          await deps.showDiff({
            title: view.title,
            original: { revision: view.left },
            modified: { revision: view.right },
            revealLine: diff!.revealLine
          });
        } catch (e: unknown) {
          logger.logError(`blame: could not show a line's change: ${String(e)}`);
          void deps.prompts.showError(l10n.t("error.unableToViewDiff"));
        }
        return;
      }
    }
  };

  return {
    offer(source, shownPath, show) {
      service.close();
      const target = blameTargetOf(source, shownPath);
      offered = target === null ? null : { file: ++files, target, blamed: false };
      return offered === null
        ? null
        : { file: offered.file, show, strings: fileBlameStrings(l10n) };
    },
    async receive(request) {
      switch (request.command) {
        case "fileBlameOpen": {
          if (offered === null || !isOffered(request.file)) return;
          offered.blamed = true;
          const answer = await service.open(offered.target);
          // Another offered, or let go, meanwhile: nobody waits for it.
          if (answer === null || !isOffered(request.file)) return;
          post({
            command: "fileBlame",
            file: request.file,
            blame: answer.kind === "blamed" ? answer.annotations : null
          });
          return;
        }
        case "fileBlameClose":
          if (offered === null || !isOffered(request.file)) return;
          offered.blamed = false;
          service.close();
          return;
        case "fileBlameHoverOf": {
          if (!isBlamed(request.file)) return;
          const markdown = await service.hover(request.line);
          // Null too: the page waits on it, and asks again next time.
          if (isBlamed(request.file)) {
            post({ command: "fileBlameHover", file: request.file, line: request.line, markdown });
          }
          return;
        }
        case "fileBlameRun":
          return run(request);
      }
    },
    async pickAndShow() {
      const root = deps.repo();
      const picked = await deps.pickFile(root);
      if (picked === null) return;
      const filePath = await pathInRepo(root, picked, deps.realpath);
      if (filePath === null) {
        void deps.prompts.showError(l10n.t("desktop.fileHistory.notInRepository", picked));
        return;
      }
      // An untracked or ignored file has no commit to blame its lines on:
      // said, rather than shown with every line not committed yet.
      if (!(await deps.isTracked(filePath))) {
        void deps.prompts.showInformation(l10n.t("desktop.blame.untracked", filePath));
        return;
      }
      const name = filePath.split("/").at(-1) ?? filePath;
      try {
        await deps.showFile({
          title: l10n.t("desktop.blame.workingTreeTitle", name),
          // Under the repository as the Tab names it: the dialog's path may
          // lead there through a link (`pathInRepo`).
          file: { workingFile: path.join(root, ...filePath.split("/")), repo: root },
          showBlame: true
        });
      } catch (e: unknown) {
        logger.logError(`blame: could not show ${filePath}: ${String(e)}`);
        void deps.prompts.showError(l10n.t("desktop.blame.cannotOpen", filePath));
      }
    },
    dispose() {
      offered = null;
      service.close();
    }
  };
}
