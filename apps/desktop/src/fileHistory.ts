/* A Tab's file history panel (#408), as the main process answers it: its
 * reads handed to core's file history service, the diff of an entry shown
 * through the Tab's diff viewer (#404), and the application menu's File
 * History… — a file picked in the system's dialog. Apart from Electron, so
 * the tests drive it as the page and the menu do. */

import { promises as fs } from "node:fs";
import path from "node:path";

import { type FileHistoryService, fileHistoryDiff } from "@ging/core/extension/fileHistoryService";
import type { HostLogger, L10n, Prompts } from "@ging/core/host/ports";
import type {
  FileHistoryHostMessage,
  FileHistoryRequest,
  FileHistoryStrings
} from "@ging/webview/desktop/fileHistory/protocol";

import { type ShowDiff, commitDiffRequest } from "./diffViewer";

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
  prompts: Pick<Prompts, "showError" | "showInformation">;
  l10n: L10n;
  logger: Pick<HostLogger, "logError">;
  /** The real path of a file: `fs.promises.realpath` unless a test says. */
  realpath?: (file: string) => Promise<string>;
};

export type FileHistory = {
  /** What the panel asked. */
  receive(request: FileHistoryRequest): Promise<void>;
  /** The application menu's File History…: a file picked, its history from
   *  HEAD shown. */
  pickAndShow(): Promise<void>;
  /** The instance is going: stop reading any history. */
  dispose(): void;
};

/**
 * `file`, an absolute path, as a `/`-separated path within `repo`; null when
 * it is not within it. Both sides as the disk has them (`realpath`): a
 * repository opened through a junction, a symlink or a `subst` drive is the
 * folder it leads to, and a link inside the repository to a file outside it
 * is that file — outside. A file named `..foo` at the top is inside.
 */
export async function pathInRepo(
  repo: string,
  file: string,
  realpath: (file: string) => Promise<string> = (f) => fs.realpath(f)
): Promise<string | null> {
  let real: [string, string];
  try {
    real = await Promise.all([realpath(path.resolve(repo)), realpath(path.resolve(file))]);
  } catch {
    return null;
  }
  const relative = path.relative(real[0], real[1]);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/** What the menu's File History… and Blame File… ask for: a file picked in
 *  the system's dialog, as a `/`-separated path within `root` — or null,
 *  once whatever kept it from being one is said: a file outside the
 *  repository, or one git does not track (`untracked`, the key of what is
 *  said, given the path). */
export async function pickTrackedFile(
  deps: Pick<FileHistoryDeps, "pickFile" | "prompts" | "l10n" | "realpath"> & {
    isTracked: (filePath: string) => Promise<boolean>;
  },
  root: string,
  untracked: string
): Promise<string | null> {
  const { prompts, l10n } = deps;
  const picked = await deps.pickFile(root);
  if (picked === null) return null;
  const filePath = await pathInRepo(root, picked, deps.realpath);
  if (filePath === null) {
    void prompts.showError(l10n.t("desktop.fileHistory.notInRepository", picked));
    return null;
  }
  if (!(await deps.isTracked(filePath))) {
    void prompts.showInformation(l10n.t(untracked, filePath));
    return null;
  }
  return filePath;
}

export function createFileHistory(deps: FileHistoryDeps): FileHistory {
  const { service, repo, showDiff, post, l10n, logger } = deps;
  const strings = fileHistoryStrings(l10n);
  /** The history open: the `fileHistoryOpen` it answers, null for the one
   *  the menu opened; undefined when none is. */
  let open: number | null | undefined;

  /** Open a history and hand its first page to the page — unless another was
   *  opened, or the panel closed, while it was read: nobody waits for it. */
  const openHistory = async (request: number | null, filePath: string, start: string | null) => {
    open = request;
    const answer = await service.open({ path: filePath, start });
    if (answer !== null) post({ command: "fileHistory", request, ...answer, strings });
  };

  return {
    async receive(request) {
      switch (request.command) {
        case "fileHistoryReady":
          post({ command: "fileHistoryStrings", strings });
          return;
        case "fileHistoryOpen":
          return openHistory(request.request, request.path, request.start);
        case "fileHistoryMore": {
          // Only the history open: a page of one replaced is nobody's.
          if (request.request !== open) return;
          const answer = await service.more();
          if (answer !== null && request.request === open) {
            post({
              command: "fileHistory",
              request: request.request,
              ...answer,
              strings
            });
          }
          return;
        }
        case "fileHistoryClose":
          open = undefined;
          service.close();
          return;
        case "fileHistoryDiff": {
          const diff = fileHistoryDiff(repo(), request.entry);
          // A submodule's entry: the panel offers it no diff.
          if (diff === null) return;
          try {
            await showDiff(commitDiffRequest(diff, l10n));
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
      // An untracked or ignored file has no history: said, rather than shown
      // as an empty list that reads as "never changed".
      const filePath = await pickTrackedFile(
        { ...deps, isTracked: (file) => service.isTracked(file) },
        repo(),
        "desktop.fileHistory.untracked"
      );
      if (filePath !== null) await openHistory(null, filePath, null);
    },
    dispose() {
      open = undefined;
      service.close();
    }
  };
}
