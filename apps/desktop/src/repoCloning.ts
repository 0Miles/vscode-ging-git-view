/* Clone Repository on the desktop host (#395), from the Welcome page or the
 * menu: the URL asked in the Welcome page's host prompt overlay, the folder
 * to put it in asked of the system's own dialog (`NativeDialogs`, ADR-0032),
 * then core's clone, its progress shown on the Welcome page with a way to
 * cancel it, and the repository opened in a Tab. A credential git needs is
 * asked on the Welcome page too, through an askpass route of the clone's own.
 * Everything it reaches out to is handed in, so vitest drives all of it with
 * fakes. */

import type { CloneProgress } from "@ging/core/backend/actions/clone";
import type { RepoCloneCommand } from "@ging/core/extension/repoCloneCommand";
import type { HostLogger, L10n, Prompts } from "@ging/core/host/ports";
import type { NativeDialogs } from "@ging/desktop/ports/prompts";
import type { ClonePanel } from "@ging/webview/desktop/window/protocol";

/** How often at most a clone's progress is shown anew: git writes a line for
 *  every object, and each one shown is a message to the window's page. */
export const PROGRESS_INTERVAL_MS = 100;

export type RepoCloningDeps = {
  /** The Welcome page's: the URL is asked there. */
  prompts: Pick<Prompts, "input">;
  dialogs: Pick<NativeDialogs, "showOpenDialog">;
  l10n: L10n;
  logger: Pick<HostLogger, "log">;
  /** Core's Clone Repository. */
  command: Pick<RepoCloneCommand, "urlProblem" | "folderFor" | "shownUrl" | "cloneRepo">;
  /** An environment for one clone's git whose credential prompts are asked
   *  on the Welcome page (an askpass route), and how to let it go. */
  askpassRoute(): { env: NodeJS.ProcessEnv; dispose(): void };
  /** Open `repo`, a repository as git spells it, in a Tab of its own; it goes
   *  first in the recent list. */
  openRepo(repo: string): void;
  /** What `panel` or `cloning` answer has changed. */
  onChange(): void;
  now?: () => number;
};

export type RepoCloning = {
  /** Ask for a URL and a folder, and clone; then open the repository. Does
   *  nothing while a clone is asked for or running: one at a time. */
  clone(): Promise<void>;
  /** Cancel the clone running: git is sent a kill, and what it made removed. */
  cancel(): void;
  /** A clone is being asked for or running. */
  busy(): boolean;
  /** What the Welcome page shows of the clone running, or `null` with none. */
  panel(): ClonePanel | null;
  /** The window is going: the clone running is cancelled, and opens nothing.
   *  Resolves once it has ended and what it made is removed. */
  dispose(): Promise<void>;
};

/** The clone running: where to, how far, and how to stop it. */
type Running = {
  url: string;
  folder: string;
  progress: CloneProgress | null;
  abort: AbortController;
};

export function createRepoCloning(deps: RepoCloningDeps): RepoCloning {
  const { prompts, dialogs, l10n, logger, command } = deps;
  const now = deps.now ?? Date.now;
  /** Asking for the URL or the folder: no second clone meanwhile. */
  let asking = false;
  let running: Running | null = null;
  /** Settles once the clone running has ended, removed what it made included. */
  let ended: Promise<void> = Promise.resolve();
  let disposed = false;
  /** When the progress was last shown. */
  let shownAt = -Infinity;

  /** The folder the clone goes in, as the user chose it, or `null`. */
  const pickParent = async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialogs.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: l10n.t("desktop.folderDialog.clone")
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
  };

  /** Ask what to clone and where: the URL, trimmed, and the folder for it. */
  const ask = async (): Promise<{ url: string; folder: string } | null> => {
    const answer = await prompts.input({
      prompt: l10n.t("desktop.clone.urlPrompt"),
      placeholder: l10n.t("desktop.clone.urlPlaceholder"),
      validate: (text) => command.urlProblem(text)
    });
    if (answer === undefined || disposed) return null;
    const url = answer.trim();
    const parent = await pickParent();
    if (parent === null || disposed) return null;
    return { url, folder: command.folderFor(parent, url) };
  };

  const run = async ({ url, folder }: { url: string; folder: string }): Promise<void> => {
    const abort = new AbortController();
    const clone: Running = { url, folder, progress: null, abort };
    running = clone;
    deps.onChange();
    const route = deps.askpassRoute();
    logger.log(`clone: ${command.shownUrl(url)} into ${folder}`);
    let cloned: { repo: string } | undefined;
    try {
      cloned = await command.cloneRepo(url, folder, {
        signal: abort.signal,
        gitEnv: route.env,
        onProgress: (progress) => {
          clone.progress = progress;
          // Every so often, and always at a stage's end.
          if (now() - shownAt < PROGRESS_INTERVAL_MS && progress.percent < 100) return;
          shownAt = now();
          deps.onChange();
        }
      });
    } finally {
      route.dispose();
      running = null;
      deps.onChange();
    }
    if (cloned !== undefined && !disposed) {
      logger.log(`clone: cloned ${cloned.repo}`);
      deps.openRepo(cloned.repo);
    } else {
      logger.log(abort.signal.aborted ? "clone: cancelled" : "clone: did not clone");
    }
  };

  return {
    clone: async () => {
      if (asking || running !== null || disposed) {
        logger.log("clone: one is already being asked for or running");
        return;
      }
      asking = true;
      deps.onChange();
      let target: { url: string; folder: string } | null;
      try {
        target = await ask();
      } finally {
        asking = false;
        deps.onChange();
      }
      if (target === null) return;
      ended = run(target);
      await ended;
    },

    cancel: () => {
      if (running === null || running.abort.signal.aborted) return;
      logger.log("clone: cancelling");
      running.abort.abort();
      deps.onChange();
    },

    busy: () => asking || running !== null,

    panel: () => {
      if (running === null) return null;
      const cancelling = running.abort.signal.aborted;
      return {
        title: l10n.t("desktop.clone.title", command.shownUrl(running.url)),
        folder: l10n.t("desktop.clone.into", running.folder),
        stage: cancelling
          ? l10n.t("desktop.clone.cancelling")
          : (running.progress?.text ?? l10n.t("desktop.clone.starting")),
        percent: cancelling ? null : (running.progress?.percent ?? null),
        cancelling,
        cancel: l10n.t("dialog.cancel")
      };
    },

    dispose: () => {
      disposed = true;
      running?.abort.abort();
      // A clone that failed has said so already: only its end is waited for.
      return ended.catch(() => {});
    }
  };
}
