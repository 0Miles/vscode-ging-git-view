/* The desktop `Opener` (`@ging/core/host/ports`), one per webview instance
 * (#391): what it notifies is said in that instance's window. A working-tree
 * file opens in whatever program the system opens it with, a link in the
 * browser, a terminal is the system's own. What the desktop app has no screen
 * for yet — a file at a revision, a diff, a merge — is said to be so, and
 * answered as done: see `notSupportedYet`. */

import path from "node:path";

import type { HostLogger, L10n, Opener, Prompts } from "@ging/core/host/ports";
import { isWebUrl } from "@ging/shared/webUrl";

/**
 * What the system opens things with: Electron's `shell`, and a terminal
 * (terminal.ts). A seam, as `NativeDialogs` is (ADR-0032): no test should
 * start a program or a browser, so the vitest suite hands over a fake, and
 * the main process hands over functions that look the real ones up when
 * called, so the Electron E2E can stand in for them.
 */
export type OsShell = {
  /** Electron's `shell.openPath`: resolves to `""` once the system has opened
   *  `file`, to why not otherwise. */
  openPath(file: string): Promise<string>;
  /** Electron's `shell.showItemInFolder`. */
  showItemInFolder(file: string): void;
  /** Electron's `shell.openExternal`. */
  openExternal(url: string): Promise<void>;
  /** Start the system's terminal in `cwd`, titled `title` where it can be;
   *  resolves once it has started. */
  openTerminal(cwd: string, title: string): Promise<void>;
};

type Notifier = {
  prompts: Pick<Prompts, "showInformation">;
  l10n: L10n;
  logger: Pick<HostLogger, "log">;
};

/**
 * Tell the user that `what` is not in the desktop app yet, and say in the log
 * which ticket brings it. Not awaited: the notice needs no answer, and what
 * asked for it goes on as if done. That is the point — see the stubs below.
 */
export function notSupportedYet({ prompts, l10n, logger }: Notifier, what: string): void {
  logger.log(`desktop: ${what} is not supported yet`);
  void prompts.showInformation(l10n.t("desktop.notSupportedYet"));
}

/**
 * Open `url` in the browser, when it is a web address: nothing else leaves the
 * app this way. A webview asks with whatever the user's issue-link setting
 * built, the settings page with a description's link (#397); neither is an
 * answer to "run this", which a `file:` or custom-scheme URL handed to the
 * system can be. A failure has nobody to answer: it is logged.
 */
export function openWebUrl(
  os: Pick<OsShell, "openExternal">,
  logger: Pick<HostLogger, "log" | "logError">,
  url: string
): void {
  if (!isWebUrl(url)) {
    logger.log(`opener: not opening ${url}: not a web address`);
    return;
  }
  os.openExternal(url).catch((e: unknown) =>
    logger.logError(`opener: could not open ${url}: ${String(e)}`)
  );
}

/** Extensions the system runs rather than shows, beyond Windows' `PATHEXT`:
 *  a shortcut, a script host's, an installer, a settings file it applies. */
const RUN_ON_OPEN: Record<string, readonly string[]> = {
  win32: [".lnk", ".url", ".scr", ".pif", ".hta", ".msi", ".msp", ".cpl", ".reg", ".ps1", ".jar"],
  darwin: [".app", ".command", ".tool", ".terminal", ".pkg", ".mpkg", ".jar"],
  linux: [".desktop", ".appimage", ".run", ".sh", ".jar"]
};
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

/** Whether the system would run `file` rather than show it, by its extension.
 *  A repository is anybody's: "Open File" on a script in it must not run it. */
export function opensAsProgram(
  file: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): boolean {
  const ext = path.extname(file).toLowerCase();
  if (ext === "") return false;
  const run = [...(RUN_ON_OPEN[platform] ?? RUN_ON_OPEN.linux)];
  if (platform === "win32") {
    run.push(...(env.PATHEXT ?? DEFAULT_PATHEXT).toLowerCase().split(";"));
  }
  return run.includes(ext);
}

type DesktopOpenerDeps = {
  os: OsShell;
  /** The instance's own: what is said goes to its window. */
  prompts: Pick<Prompts, "showInformation" | "showError">;
  l10n: L10n;
  logger: Pick<HostLogger, "log" | "logError">;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
};

export function createDesktopOpener(deps: DesktopOpenerDeps): Opener {
  const { os, prompts, l10n, logger, platform, env } = deps;
  const notYet = (what: string) => notSupportedYet(deps, what);

  return {
    openFile: async (file) => {
      const native = path.normalize(file);
      if (opensAsProgram(native, platform, env)) {
        // Shown where it is instead: the user can still run it from there,
        // knowing that is what they do.
        logger.log(`opener: ${native} would run as a program; showing it in its folder`);
        os.showItemInFolder(native);
        return;
      }
      const failure = await os.openPath(native);
      if (failure !== "") {
        logger.logError(`opener: could not open ${native}: ${failure}`);
        throw new Error(failure);
      }
    },
    openExternalUrl: (url) => openWebUrl(os, logger, url),
    openTerminal: (cwd, name) => {
      const native = path.normalize(cwd);
      os.openTerminal(native, name).catch((e: unknown) => {
        // Nobody else hears of it: the port answers nothing.
        logger.logError(`opener: could not open a terminal in ${native}: ${String(e)}`);
        void prompts.showError(l10n.t("desktop.cannotOpenTerminal", String(e)));
      });
    },

    // The stubs. The port's contract is to reject what could not be opened,
    // and the graph answers a rejection with an error box of its own ("Unable
    // to open…"). These are not failures: the desktop app has no such screen
    // yet, which the notice says, so they resolve — `openCommitDiff` to true —
    // and the graph says nothing more. Each goes when the ticket named on it
    // brings the screen.
    /** #405: a file read-only at a revision. */
    openFileAtRevision: async (file) => notYet(`viewing ${file.filePath} at ${file.commit} (#405)`),
    /** #404: the diff viewer. */
    diffWithWorking: async (_left, workingPath) =>
      notYet(`a diff of ${workingPath} with the working tree (#404)`),
    /** #404: the diff viewer. */
    openCommitDiff: async (request) => {
      notYet(`a diff of ${request.newFilePath} at ${request.commitHash} (#404)`);
      return true;
    },
    /** #410: conflicts handed to the user's mergetool. */
    openMergeEditor: (_repo, filePath) => notYet(`merging ${filePath} (#410)`)
  };
}
