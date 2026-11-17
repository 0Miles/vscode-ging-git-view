/* The desktop `Opener` (`@ging/core/host/ports`), one per webview instance
 * (#391): what it notifies is said in that instance's window. A file of the
 * repository opens in the program the system shows its type with, when it is
 * a type GING knows only to be shown (`opensDirectly`), and is shown in its
 * folder otherwise; a link opens in the browser, a terminal is the system's
 * own, a conflicted file goes to the merge tool the user configured for git
 * (#410). What the desktop app has no screen for yet — a file at a revision,
 * a diff — is said to be so, and answered as done: see `notSupportedYet`. */

import fs from "node:fs";
import path from "node:path";

import type { HostLogger, L10n, Opener, Prompts } from "@ging/core/host/ports";
import { windowsVariable } from "@ging/desktop/terminal";
import { webUrl } from "@ging/shared/webUrl";

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
  // The address as parsed, not the text that was checked.
  const href = webUrl(url);
  if (href === null) {
    logger.log(`opener: not opening ${url}: not a web address`);
    return;
  }
  os.openExternal(href).catch((e: unknown) =>
    logger.logError(`opener: could not open ${href}: ${String(e)}`)
  );
}

/**
 * The extensions "Open File" hands to the system's program for them: images,
 * documents, data and source that every platform shows in a viewer or an
 * editor. Everything else is shown in its folder instead.
 *
 * An allowlist, not a list of what runs: which program the system opens a
 * file with is the system's — and every installed app's — to register, so a
 * list of what runs is never complete (shortcuts, installers, script hosts,
 * settings files the system applies, help files…) and fails open when it
 * leaks. This one fails closed: an unlisted type costs the user a folder
 * window, not a program run from somebody's repository. Left out on purpose:
 * scripts some platform runs when opened (`.js` and `.vbs` on Windows, `.py`
 * and `.rb` where an interpreter registered them, `.sh`, `.ps1`, `.bat`), and
 * pages a browser opens with their scripts on (`.html`, `.svg`, `.xml`).
 */
const OPENED_DIRECTLY = new Set([
  // Images.
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".ico",
  ".tif",
  ".tiff",
  ".avif",
  // Documents and plain text.
  ".pdf",
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".rst",
  ".adoc",
  ".csv",
  ".tsv",
  ".log",
  ".diff",
  ".patch",
  // Data and configuration.
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  // Source a compiler reads, which no platform runs.
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".hh",
  ".cs",
  ".java",
  ".kt",
  ".scala",
  ".go",
  ".rs",
  ".swift",
  ".m",
  ".mm",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".dart",
  ".hs",
  ".vue",
  ".svelte"
]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
const EXECUTE_BITS = 0o111;

/**
 * Whether "Open File" hands `file` — a real path, not a link — to the
 * system's program for it, rather than showing it in its folder. A repository
 * is anybody's: opening a file in it must never run it. So the file's type
 * must be one `OPENED_DIRECTLY` lists; on Windows, not one `PATHEXT` makes a
 * program; and elsewhere it must not be executable, which macOS (and some
 * Linux desktops) run in a terminal whatever its name. Windows ignores the
 * dots and spaces a name ends with, so they are not read as its extension.
 */
export function opensDirectly(
  file: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  mode: number
): boolean {
  const name =
    platform === "win32" ? path.basename(file).replace(/[. ]+$/, "") : path.basename(file);
  const ext = path.extname(name).toLowerCase();
  if (!OPENED_DIRECTLY.has(ext)) return false;
  if (platform === "win32") {
    return !(windowsVariable(env, "PATHEXT") ?? DEFAULT_PATHEXT)
      .toLowerCase()
      .split(";")
      .includes(ext);
  }
  return (mode & EXECUTE_BITS) === 0;
}

/** What `openFile` reads of the file system: a seam, so the vitest suite can
 *  hand over links and modes no test machine has to make. */
export type FileFacts = {
  /** The path with every link followed; rejects when there is none. */
  realpath(file: string): Promise<string>;
  /** Its permission bits. */
  mode(file: string): Promise<number>;
};

const systemFiles: FileFacts = {
  // The native one: on Windows it spells the path as the file system does,
  // case and all, so two spellings of one folder compare equal.
  realpath: (file) => realpathNative(file),
  mode: async (file) => (await fs.promises.stat(file)).mode
};

function realpathNative(file: string): Promise<string> {
  return new Promise((resolve, reject) =>
    fs.realpath.native(file, (e, resolved) => (e ? reject(e) : resolve(resolved)))
  );
}

/** Whether `file` is `root` or inside it; both real paths. */
function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type DesktopOpenerDeps = {
  os: OsShell;
  /** The instance's own: what is said goes to its window. */
  prompts: Pick<Prompts, "showInformation" | "showError">;
  l10n: L10n;
  logger: Pick<HostLogger, "log" | "logError">;
  /** The repository the instance shows: the only one it opens files from. */
  repoRoot: () => string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  files?: FileFacts;
  /** Hand a conflicted file, relative to the repository, to the user's merge
   *  tool (core's `ConflictCommands.mergeTool`), which says what came of it. */
  mergeTool: (filePath: string) => void;
};

export function createDesktopOpener(deps: DesktopOpenerDeps): Opener {
  const { os, prompts, l10n, logger, repoRoot, platform, env, files = systemFiles } = deps;
  const { mergeTool } = deps;
  const notYet = (what: string) => notSupportedYet(deps, what);
  /** Log why `file` is not opened, and reject with it. */
  const refuse = (file: string, why: string): never => {
    logger.logError(`opener: not opening ${file}: ${why}`);
    throw new Error(why);
  };

  return {
    openFile: async (file) => {
      const asked = path.normalize(file);
      // A colon past the drive letter names a stream of the file, not the
      // file — `a.bat::$DATA` is `a.bat`, and no extension check sees it.
      if (platform === "win32" && asked.indexOf(":", 2) !== -1) {
        refuse(asked, "not a plain file path");
      }
      // What the request names is the repository's own working tree; the
      // webview builds it from a path git gave, so `..`, an absolute path or a
      // link out of the repository is nothing it should name.
      const [real, root] = await Promise.all([files.realpath(asked), files.realpath(repoRoot())]);
      if (!isWithin(root, real)) refuse(asked, "not in the repository");
      // Judged on what the path leads to: a link named `notes.txt` can lead
      // to a program.
      if (!opensDirectly(real, platform, env, await files.mode(real))) {
        // Shown where it is instead: the user can still open it from there,
        // knowing what it is.
        logger.log(`opener: ${real} is no type GING opens; showing it in its folder`);
        os.showItemInFolder(real);
        return;
      }
      const failure = await os.openPath(real);
      if (failure !== "") refuse(real, failure);
    },
    openExternalUrl: (url) => openWebUrl(os, logger, url),
    openTerminal: (cwd, name) => {
      const asked = path.normalize(cwd);
      // In the repository of the Tab that asked, as `openFile` opens only
      // from it: the folder the request names must be in it.
      void Promise.all([files.realpath(asked), files.realpath(repoRoot())])
        .then(([real, root]) => {
          if (!isWithin(root, real)) throw new Error("not in the repository");
          return os.openTerminal(real, name);
        })
        .catch((e: unknown) => {
          // Nobody else hears of it: the port answers nothing.
          logger.logError(`opener: could not open a terminal in ${asked}: ${String(e)}`);
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
    // The desktop app has no 3-way editor of its own (#411's): the file goes
    // to the merge tool the user configured for git (#410), on the instance's
    // own repository — the only one its graph is shown, whatever `repo` the
    // request names.
    openMergeEditor: (_repo, filePath) => mergeTool(filePath)
  };
}
