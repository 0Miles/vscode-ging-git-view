/* A Tab's file history panel (#408), as the main process answers it: its
 * reads handed to core's file history service, the diff of an entry shown
 * through the Tab's diff viewer (#404), and the application menu's File
 * History… — a file picked in the system's dialog. Apart from Electron, so
 * the tests drive it as the page and the menu do. */

import path from "node:path";

import { commitDiffView } from "@ging/core/extension/commitDiff";
import { type FileHistoryService, fileHistoryDiff } from "@ging/core/extension/fileHistoryService";
import type { HostLogger, L10n, Prompts } from "@ging/core/host/ports";
import type {
  FileHistoryHostMessage,
  FileHistoryRequest,
  FileHistoryStrings
} from "@ging/webview/desktop/fileHistory/protocol";

import type { ShowDiff } from "./diffViewer";

/** The panel's words, in the app's language; `{0}` and `{1}` left for the
 *  panel to fill in. */
export function fileHistoryStrings(l10n: Pick<L10n, "t">): FileHistoryStrings {
  const t = (key: string, ...args: string[]) => l10n.t(`desktop.fileHistory.${key}`, ...args);
  return {
    menuItem: t("menuItem"),
    title: t("title", "{0}"),
    upTo: t("upTo", "{0}"),
    close: t("close"),
    loadMore: t("loadMore"),
    empty: t("empty"),
    renamedFrom: t("renamedFrom", "{0}"),
    copiedFrom: t("copiedFrom", "{0}"),
    asPath: t("asPath", "{0}"),
    added: t("added"),
    deleted: t("deleted"),
    merge: t("merge"),
    submodule: t("submodule", "{0}", "{1}")
  };
}

export type FileHistoryDeps = {
  service: FileHistoryService;
  /** The Tab's repository. */
  repo: () => string;
  /** Its diff viewer. */
  showDiff: ShowDiff;
  /** Hand its page a message. */
  post: (message: FileHistoryHostMessage) => void;
  /** A file of the repository, picked in the system's dialog opened on it;
   *  null when none was. */
  pickFile: (repo: string) => Promise<string | null>;
  prompts: Pick<Prompts, "showError">;
  l10n: L10n;
  logger: Pick<HostLogger, "logError">;
};

export type FileHistory = {
  /** What the panel asked. */
  receive(request: FileHistoryRequest): Promise<void>;
  /** The application menu's File History…: a file picked, its history from
   *  HEAD shown. */
  pickAndShow(): Promise<void>;
};

/** `file`, an absolute path, as a `/`-separated path within `repo`; null
 *  when it is not within it. */
export function pathInRepo(repo: string, file: string): string | null {
  const relative = path.relative(path.resolve(repo), path.resolve(file));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

export function createFileHistory(deps: FileHistoryDeps): FileHistory {
  const { service, repo, showDiff, post, l10n, logger } = deps;
  const strings = () => fileHistoryStrings(l10n);

  /** Read a page and hand it to the page: an offset of 0 opens the panel on it. */
  const load = async (filePath: string, start: string | null, offset: number) => {
    const answer = await service.load({ path: filePath, start, offset });
    post({ command: "fileHistory", ...answer, strings: strings() });
  };

  return {
    async receive(request) {
      switch (request.command) {
        case "fileHistoryReady":
          post({ command: "fileHistoryStrings", strings: strings() });
          return;
        case "fileHistoryLoad":
          return load(request.path, request.start, request.offset);
        case "fileHistoryDiff": {
          const diff = fileHistoryDiff(repo(), request.entry);
          // A submodule's entry: the panel offers it no diff.
          if (diff === null) return;
          const view = commitDiffView(diff, {
            addedIn: (abbrevHash) => l10n.t("diff.addedIn", abbrevHash),
            deletedIn: (abbrevHash) => l10n.t("diff.deletedIn", abbrevHash)
          });
          try {
            await showDiff({
              title: view.title,
              original: { revision: view.left },
              modified: { revision: view.right }
            });
          } catch (e: unknown) {
            // Refused (a revision that is none: the page is not taken at its
            // word) or unreadable; the page has no one waiting on it.
            logger.logError(
              `file history: could not show a diff of ${diff.newFilePath}: ${String(e)}`
            );
          }
          return;
        }
      }
    },
    async pickAndShow() {
      const root = repo();
      const picked = await deps.pickFile(root);
      if (picked === null) return;
      const filePath = pathInRepo(root, picked);
      if (filePath === null) {
        void deps.prompts.showError(l10n.t("desktop.fileHistory.notInRepository", picked));
        return;
      }
      await load(filePath, null, 0);
    }
  };
}
