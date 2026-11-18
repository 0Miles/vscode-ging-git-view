/* How the desktop host opens a repository the user points at (#394): Open
 * Folder and Initialize Repository, from the Welcome page or the menu, and a
 * repository of the recently opened list. The folder is asked of the system's
 * own dialog, through `NativeDialogs` (ADR-0032); what opens it in a Tab, what
 * checks a folder and what makes a repository are handed in, so vitest drives
 * all of it with fakes. */

import type { HostLogger, L10n } from "@ging/core/host/ports";
import { type NativeDialogs, pickOne } from "@ging/desktop/ports/prompts";

import type { RepoToOpen, Unusable } from "./repoToOpen";

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
  /** `repo` as an open Tab or the known set spells it, if it is one of
   *  theirs under another spelling; otherwise as given (`TabWindow.resolve`,
   *  the spelling `openRepo` opens it under). */
  resolve(repo: string): string;
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

/** The folder the user chose, its dialog's button saying `button`, or `null`
 *  when they chose none. */
export function pickFolder(
  dialogs: Pick<NativeDialogs, "showOpenDialog">,
  button: string
): Promise<string | null> {
  return pickOne(dialogs, {
    // `createDirectory` is macOS's: Windows' and Linux's dialogs can make a
    // folder as they are.
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: button
  });
}

export function createRepoOpening(deps: RepoOpeningDeps): RepoOpening {
  const { dialogs, l10n, logger } = deps;

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

  /** Say why `path` opens nothing, in a box over the window. */
  const cannotOpen = (path: string, why: Unusable) =>
    dialogs.showMessageBox({
      type: "error",
      message: l10n.t("error.unableToLoadGitGraph"),
      detail: l10n.t(CANNOT_OPEN[why], path)
    });

  return {
    openFolder: async () => {
      const folder = await pickFolder(dialogs, l10n.t("desktop.folderDialog.open"));
      if (folder === null) return;
      const target = await deps.check(folder);
      if ("repo" in target) {
        logger.log(`open folder: opening ${target.repo}`);
        deps.openRepo(target.repo);
        return;
      }
      logger.log(`open folder: cannot open ${folder} (${target.why})`);
      // Only a folder in no repository is one to make a repository in: a
      // bare one, or a .git folder, has no working tree to give it.
      if (target.why !== "notRepository") {
        await cannotOpen(folder, target.why);
        return;
      }
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
      const folder = await pickFolder(dialogs, l10n.t("desktop.folderDialog.initialize"));
      if (folder !== null) await init(folder);
    },

    openRecent: async (repo) => {
      const target = await deps.check(repo);
      if ("repo" in target) {
        // The repository itself, however git spells it today (a symlink, a
        // short name, a drive letter's case: `resolve`), not one around its
        // folder: a folder whose own repository has gone may now be inside
        // another, which is not the one the list names.
        if (deps.resolve(target.repo) === repo) {
          logger.log(`recent: opening ${repo}`);
          deps.openRepo(repo);
          return;
        }
        logger.log(`recent: cannot open ${repo}, it is inside ${target.repo} now`);
        await cannotOpen(repo, "notRepository");
        return;
      }
      logger.log(`recent: cannot open ${repo} (${target.why})`);
      await cannotOpen(repo, target.why);
    }
  };
}

/** What each `Unusable` says, of the path. */
const CANNOT_OPEN: Record<Unusable, string> = {
  missing: "desktop.folderNotFound",
  notRepository: "desktop.cannotOpenRepo",
  noWorkTree: "desktop.noWorkTree"
};
