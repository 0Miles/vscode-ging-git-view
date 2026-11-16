/* The system terminal the desktop `Opener` opens (#391): which program, with
 * which arguments, on each platform, and starting it. Which one is a pure
 * answer, tested without starting anything; starting it goes through a
 * `spawn` the caller hands over. */

import type { ChildProcess, SpawnOptions } from "node:child_process";

/** One way of starting a terminal: a program, its arguments, how. */
export type TerminalLaunch = { command: string; args: string[]; options: SpawnOptions };

/** Node's `spawn`, as far as starting a terminal uses it. */
export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * The ways to start a terminal in `cwd` on `platform`, to be tried in order:
 * the next only when the program of the one before is not installed. Each is
 * detached, with nothing of the app's own stdio, so the terminal outlives the
 * app and is the user's from the start.
 *
 * - Windows: `cmd /c start`, which gives the new `cmd.exe` a console window
 *   of its own titled `title` — the way VS Code's external terminal starts it.
 *   The line is the caller's verbatim: `start` reads the first quoted argument
 *   as the window's title, and Node's own quoting would escape quotes the way
 *   `cmd` does not read them.
 * - macOS: Terminal, opened on the folder. It takes no title.
 * - Linux: the terminal Debian's alternatives name (`x-terminal-emulator`),
 *   then the desktop's own, then xterm, as VS Code's external terminal picks
 *   one. None of them is told a title the same way, so none is.
 */
export function terminalLaunches(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
  title: string
): TerminalLaunch[] {
  const options: SpawnOptions = { cwd, detached: true, stdio: "ignore" };
  if (platform === "win32") {
    const cmd = env.ComSpec ?? `${env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
    // No `"` can be in a Windows path, but the title is not only a path.
    const quoted = `"${title.replaceAll('"', "")}"`;
    return [
      {
        command: cmd,
        args: ["/d", "/c", "start", quoted, "cmd.exe"],
        options: { ...options, windowsVerbatimArguments: true }
      }
    ];
  }
  if (platform === "darwin") {
    return [{ command: "open", args: ["-a", "Terminal", cwd], options }];
  }
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`.toLowerCase();
  const desktops: string[] = [];
  if (/gnome|unity|ubuntu|cinnamon/.test(desktop)) desktops.push("gnome-terminal");
  if (/kde|plasma/.test(desktop)) desktops.push("konsole");
  if (/xfce/.test(desktop)) desktops.push("xfce4-terminal");
  return ["x-terminal-emulator", ...desktops, "xterm"].map((command) => ({
    command,
    args: [],
    options
  }));
}

/** Resolves once `child` has started, rejects when it could not be. */
function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => {
      // Not waited for: the terminal is the user's now.
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

/** Start the first of `launches` whose program is installed. Rejects with why
 *  the last one could not start when none could, or at the first failure that
 *  is not a missing program — trying the next would not mend that. */
export async function launchTerminal(spawn: Spawn, launches: TerminalLaunch[]): Promise<void> {
  let failure: unknown = new Error("no terminal to start");
  for (const { command, args, options } of launches) {
    try {
      await started(spawn(command, args, options)); // eslint-disable-line no-await-in-loop -- the next only if this one is not installed
      return;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      failure = e;
    }
  }
  throw failure;
}
