/* The system terminal the desktop `Opener` opens (#391): which program, with
 * which arguments, on each platform, and starting it. Which one is a pure
 * answer, tested without starting anything; starting it goes through a
 * `spawn` the caller hands over. */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** One way of starting a terminal: a program, its arguments, how. */
export type TerminalLaunch = { command: string; args: string[]; options: SpawnOptions };

/** Node's `spawn`, as far as starting a terminal uses it. */
export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Windows variable `name` in `env`, whatever the case it is spelled in.
 * Windows names its variables without regard to case, and `process.env` reads
 * them that way there, but a copy of it is a plain object: a shell such as Git
 * Bash hands its children `COMSPEC` where Windows itself says `ComSpec`.
 */
export function windowsVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Whether `file` is a file this process may run. */
export function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * `name` found on `env.PATH` as an absolute path, or `null`. Only the PATH's
 * absolute entries count: an empty or relative one (`.`) would be read
 * against the terminal's folder — the repository — where anybody's
 * `x-terminal-emulator` could be waiting.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  isExecutable: (file: string) => boolean
): string | null {
  for (const dir of (env.PATH ?? "").split(path.posix.delimiter)) {
    if (!path.posix.isAbsolute(dir)) continue;
    const file = path.posix.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

/**
 * The ways to start a terminal in `cwd` on `platform`, to be tried in order:
 * the next only when the one before could not start. Each is detached, with
 * nothing of the app's own stdio, so the terminal outlives the app and is the
 * user's from the start.
 *
 * Every program is named by an absolute path, never by a name for the system
 * to look up: the terminal's folder is the repository, and a lookup that
 * reads the current folder — Windows' does, first — would run whatever
 * program of that name the repository holds.
 *
 * - Windows: `cmd /c start`, which gives a new `cmd.exe` a console window of
 *   its own titled `title` — the way VS Code's external terminal starts it.
 *   Both are `ComSpec`, absolute, or the system's own. The line is the
 *   caller's verbatim: `start` reads the first quoted argument as the
 *   window's title, and Node's own quoting would escape quotes the way `cmd`
 *   does not read them. `cmd /c` expands `%NAME%` even inside quotes, so the
 *   title keeps no `%`, and no `"` that would end it.
 * - macOS: Terminal, opened on the folder by `/usr/bin/open`. It takes no title.
 * - Linux: the terminal Debian's alternatives name (`x-terminal-emulator`),
 *   then the desktop's own, then xterm — as VS Code's external terminal picks
 *   one — each as found on the PATH's absolute folders, and only those found.
 *   None of them is told a title the same way, so none is.
 */
export function terminalLaunches(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
  title: string,
  isExecutable: (file: string) => boolean = isExecutableFile
): TerminalLaunch[] {
  const options: SpawnOptions = { cwd, detached: true, stdio: "ignore" };
  if (platform === "win32") {
    const root = windowsVariable(env, "SystemRoot");
    const system = `${root !== undefined && path.win32.isAbsolute(root) ? root : "C:\\Windows"}\\System32\\cmd.exe`;
    const comSpec = windowsVariable(env, "ComSpec");
    const cmd = comSpec !== undefined && path.win32.isAbsolute(comSpec) ? comSpec : system;
    const quoted = `"${title.replaceAll(/["%]/g, "")}"`;
    return [
      {
        command: cmd,
        args: ["/d", "/c", "start", quoted, `"${cmd}"`],
        options: { ...options, windowsVerbatimArguments: true }
      }
    ];
  }
  if (platform === "darwin") {
    return [{ command: "/usr/bin/open", args: ["-a", "Terminal", cwd], options }];
  }
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`.toLowerCase();
  const desktops: string[] = [];
  if (/gnome|unity|ubuntu|cinnamon/.test(desktop)) desktops.push("gnome-terminal");
  if (/kde|plasma/.test(desktop)) desktops.push("konsole");
  if (/xfce/.test(desktop)) desktops.push("xfce4-terminal");
  return ["x-terminal-emulator", ...desktops, "xterm"].flatMap((name) => {
    const command = findOnPath(name, env, isExecutable);
    return command === null ? [] : [{ command, args: [], options }];
  });
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
