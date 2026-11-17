/* How the desktop host opens a repository the user points at (#394): Open
 * Folder and Initialize Repository, from the Welcome page or the menu, and a
 * repository of the recently opened list. The folder is asked of the system's
 * own dialog, through `NativeDialogs` (ADR-0032); what opens it in a Tab, what
 * checks a folder and what makes a repository are handed in, so vitest drives
 * all of it with fakes. */

import type { HostLogger, L10n } from "@ging/core/host/ports";
import type { NativeDialogs } from "@ging/desktop/ports/prompts";

import type { RepoToOpen } from "./repoToOpen";

/** What Initialize Repository answers: the repository, and whether it made it. */
type Initialized = { repo: string; created: boolean };

export type RepoOpeningDeps = {
  dialogs: Pick<NativeDialogs, "showOpenDialog" | "showMessageBox">;
  l10n: L10n;
  logger: Pick<HostLogger, "log">;
  /** The repository `folder` names, or that it names none (`repoToOpen`). */
  check(folder: string): Promise<RepoToOpen>;
  /** Core's Initialize Repository: a repository in `folder`, or `undefined`
   *  once it has said why there is none. */
  initRepo(folder: string): Promise<Initialized | undefined>;
  /** Open `repo`, a repository as git spells it, in a Tab of its own, or
   *  focus the Tab it is open in; it goes first in the recent list. */
  openRepo(repo: string): void;
};

export type RepoOpening = {
  /** Ask for a folder and open the repository it is in. A folder in none is
   *  offered Initialize Repository instead. */
  openFolder(): Promise<void>;
  /** Ask for a folder — the dialog can make one — and open the repository
   *  made there; a folder that already is one is opened as it is. */
  initRepo(): Promise<void>;
  /** Open `repo`, a repository of the recent list, if it still is one;
   *  otherwise say so. It stays on the list either way (GLOSSARY.md's
   *  Current repository: nothing tells a deleted folder from an unmounted
   *  one). */
  openRecent(repo: string): Promise<void>;
};

export function createRepoOpening(deps: RepoOpeningDeps): RepoOpening {
  const { dialogs, l10n, logger } = deps;

  /** The folder the user chose, its dialog's button saying `button`, or
   *  `null` when they chose none. */
  const pickFolder = async (button: string): Promise<string | null> => {
    const { canceled, filePaths } = await dialogs.showOpenDialog({
      // `createDirectory` is macOS's: Windows' and Linux's dialogs can make a
      // folder as they are.
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: button
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
  };

  const init = async (folder: string): Promise<void> => {
    const made = await deps.initRepo(folder);
    if (made === undefined) return;
    logger.log(
      made.created
        ? `init: made a repository in ${made.repo}`
        : `init: ${made.repo} already is a repository, opening it`
    );
    deps.openRepo(made.repo);
  };

  return {
    openFolder: async () => {
      const folder = await pickFolder(l10n.t("desktop.openFolder.button"));
      if (folder === null) return;
      const target = await deps.check(folder);
      if ("repo" in target) {
        logger.log(`open folder: opening ${target.repo}`);
        deps.openRepo(target.repo);
        return;
      }
      logger.log(`open folder: ${folder} is not a Git repository`);
      const { response } = await dialogs.showMessageBox({
        type: "warning",
        message: l10n.t("desktop.cannotOpenRepo", folder),
        buttons: [l10n.t("desktop.initThisFolder"), l10n.t("dialog.cancel")],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0) await init(folder);
    },

    initRepo: async () => {
      const folder = await pickFolder(l10n.t("desktop.initRepo.button"));
      if (folder !== null) await init(folder);
    },

    openRecent: async (repo) => {
      const target = await deps.check(repo);
      // The repository itself, not one around its folder: a folder whose own
      // repository has gone may now be inside another, which is not the one
      // the list names.
      if ("repo" in target && target.repo === repo) {
        logger.log(`recent: opening ${repo}`);
        deps.openRepo(repo);
        return;
      }
      logger.log(`recent: cannot open ${repo}, not a Git repository`);
      await dialogs.showMessageBox({
        type: "error",
        message: l10n.t("error.unableToLoadGitGraph"),
        detail: l10n.t("desktop.cannotOpenRepo", repo)
      });
    }
  };
}
