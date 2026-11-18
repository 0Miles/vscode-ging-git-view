import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findOnPath,
  launchTerminal,
  type Spawn,
  terminalLaunches,
  windowsVariable
} from "@ging/desktop/terminal";

// Which terminal the desktop Opener starts, and how (#391). Nothing here
// starts one: `launchTerminal` is driven through a fake `spawn`.

const CWD = "C:/work/repo";
const COMSPEC = "C:\\Windows\\system32\\cmd.exe";
/** A Linux machine whose terminals are all in /usr/bin. */
const installed = (file: string) => file.startsWith("/usr/bin/");

describe("terminalLaunches", () => {
  it("starts cmd in a console of its own on Windows, titled, in the folder", () => {
    const [launch, ...rest] = terminalLaunches("win32", { ComSpec: COMSPEC }, CWD, "GING: repo");
    expect(rest).toEqual([]);
    expect(launch).toEqual({
      command: COMSPEC,
      args: ["/d", "/c", "start", '"GING: repo"', `"${COMSPEC}"`],
      options: {
        cwd: CWD,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true
      }
    });
  });

  it("names the program `start` runs by its absolute path, never one the repository could hold", () => {
    // `start cmd.exe` would look in the current folder — the repository — first.
    const [launch] = terminalLaunches("win32", { ComSpec: COMSPEC }, CWD, "t");
    const inner = launch.args.at(-1)!.replaceAll('"', "");
    expect(path.win32.isAbsolute(inner)).toBe(true);
    expect(path.win32.isAbsolute(launch.command)).toBe(true);
  });

  it("finds cmd under the system root when ComSpec is not set, or not absolute", () => {
    for (const env of [{ SystemRoot: "D:\\Win" }, { SystemRoot: "D:\\Win", ComSpec: "cmd.exe" }]) {
      const [launch] = terminalLaunches("win32", env, CWD, "GING: repo");
      expect(launch.command).toBe("D:\\Win\\System32\\cmd.exe");
      expect(launch.args.at(-1)).toBe('"D:\\Win\\System32\\cmd.exe"');
    }
  });

  it("reads ComSpec and SystemRoot however the environment spells them", () => {
    // Git Bash hands its children `COMSPEC` and `SYSTEMROOT`.
    const [launch] = terminalLaunches("win32", { COMSPEC: "E:\\cmd.exe" }, CWD, "t");
    expect(launch.command).toBe("E:\\cmd.exe");
    const [fallback] = terminalLaunches("win32", { SYSTEMROOT: "D:\\Win" }, CWD, "t");
    expect(fallback.command).toBe("D:\\Win\\System32\\cmd.exe");
  });

  it("falls back to C:\\Windows when neither variable is set", () => {
    const [launch] = terminalLaunches("win32", {}, CWD, "t");
    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args.at(-1)).toBe('"C:\\Windows\\System32\\cmd.exe"');
  });

  it("keeps neither a quote nor a percent sign in the title, which cmd would read", () => {
    const [launch] = terminalLaunches("win32", { ComSpec: COMSPEC }, CWD, 'GING: "a%PATH%b"');
    expect(launch.args[3]).toBe('"GING: aPATHb"');
  });

  it("opens Terminal on the folder on macOS, through /usr/bin/open", () => {
    expect(terminalLaunches("darwin", {}, "/work/repo", "GING: repo")).toEqual([
      {
        command: "/usr/bin/open",
        args: ["-a", "Terminal", "/work/repo"],
        options: { cwd: "/work/repo", detached: true, stdio: "ignore" }
      }
    ]);
  });

  it("tries Debian's choice, then the desktop's own, then xterm on Linux, as found on the PATH", () => {
    const programs = (env: NodeJS.ProcessEnv) =>
      terminalLaunches("linux", { PATH: "/usr/bin", ...env }, "/work/repo", "t", installed).map(
        (l) => l.command
      );

    expect(programs({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toEqual([
      "/usr/bin/x-terminal-emulator",
      "/usr/bin/gnome-terminal",
      "/usr/bin/xterm"
    ]);
    expect(programs({ XDG_CURRENT_DESKTOP: "KDE" })).toEqual([
      "/usr/bin/x-terminal-emulator",
      "/usr/bin/konsole",
      "/usr/bin/xterm"
    ]);
    expect(programs({ DESKTOP_SESSION: "xfce" })).toEqual([
      "/usr/bin/x-terminal-emulator",
      "/usr/bin/xfce4-terminal",
      "/usr/bin/xterm"
    ]);
    expect(programs({})).toEqual(["/usr/bin/x-terminal-emulator", "/usr/bin/xterm"]);
    for (const launch of terminalLaunches(
      "linux",
      { PATH: "/usr/bin" },
      "/work/repo",
      "t",
      installed
    )) {
      expect(launch.options).toEqual({ cwd: "/work/repo", detached: true, stdio: "ignore" });
    }
  });

  it("leaves out a Linux terminal that is not installed", () => {
    const launches = terminalLaunches(
      "linux",
      { PATH: "/usr/bin" },
      "/work/repo",
      "t",
      (file) => file === "/usr/bin/xterm"
    );
    expect(launches.map((l) => l.command)).toEqual(["/usr/bin/xterm"]);
  });
});

describe("windowsVariable", () => {
  it("finds a variable whatever its case, and not one that is empty", () => {
    expect(windowsVariable({ COMSPEC: "a" }, "ComSpec")).toBe("a");
    expect(windowsVariable({ comspec: "b" }, "ComSpec")).toBe("b");
    expect(windowsVariable({ ComSpec: "" }, "ComSpec")).toBeUndefined();
    expect(windowsVariable({}, "ComSpec")).toBeUndefined();
  });
});

describe("findOnPath", () => {
  it("reads only the PATH's absolute folders, never the current one", () => {
    const asked: string[] = [];
    const found = findOnPath("xterm", { PATH: ".::bin:/opt/x:/usr/bin" }, (file) => {
      asked.push(file);
      return file === "/usr/bin/xterm";
    });

    expect(found).toBe("/usr/bin/xterm");
    expect(asked).toEqual(["/opt/x/xterm", "/usr/bin/xterm"]);
  });

  it("answers null when no folder holds it", () => {
    expect(findOnPath("xterm", { PATH: "/usr/bin" }, () => false)).toBeNull();
    expect(findOnPath("xterm", {}, () => true)).toBeNull();
  });
});

/** A spawn whose children start, or fail with `failures[command]`, as Node's
 *  do: asynchronously, through their events. */
function fakeSpawn(failures: Record<string, string>) {
  const spawned: string[] = [];
  const unrefed: string[] = [];
  const spawn: Spawn = (command) => {
    spawned.push(command);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => unrefed.push(command);
    queueMicrotask(() => {
      const code = failures[command];
      if (code === undefined) child.emit("spawn");
      else child.emit("error", Object.assign(new Error(`spawn ${command} ${code}`), { code }));
    });
    return child;
  };
  return { spawn, spawned, unrefed };
}

const launches = (...commands: string[]) =>
  commands.map((command) => ({ command, args: [], options: {} }));

describe("launchTerminal", () => {
  it("starts the first program that is installed, and lets it go", async () => {
    const fake = fakeSpawn({ "x-terminal-emulator": "ENOENT" });

    await launchTerminal(fake.spawn, launches("x-terminal-emulator", "gnome-terminal", "xterm"));

    expect(fake.spawned).toEqual(["x-terminal-emulator", "gnome-terminal"]);
    expect(fake.unrefed).toEqual(["gnome-terminal"]);
  });

  it("rejects with the last program's failure when none is installed", async () => {
    const fake = fakeSpawn({ a: "ENOENT", b: "ENOENT" });

    await expect(launchTerminal(fake.spawn, launches("a", "b"))).rejects.toThrow("spawn b ENOENT");
  });

  it("rejects when there is no terminal to try", async () => {
    await expect(launchTerminal(fakeSpawn({}).spawn, [])).rejects.toThrow("no terminal to start");
  });

  it("does not try the next program for a failure that is not a missing one", async () => {
    const fake = fakeSpawn({ a: "EACCES" });

    await expect(launchTerminal(fake.spawn, launches("a", "b"))).rejects.toThrow("spawn a EACCES");
    expect(fake.spawned).toEqual(["a"]);
  });
});
