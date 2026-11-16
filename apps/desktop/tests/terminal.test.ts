import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { launchTerminal, type Spawn, terminalLaunches } from "@ging/desktop/terminal";

// Which terminal the desktop Opener starts, and how (#391). Nothing here
// starts one: `launchTerminal` is driven through a fake `spawn`.

const CWD = "C:/work/repo";

describe("terminalLaunches", () => {
  it("starts cmd in a console of its own on Windows, titled, in the folder", () => {
    const [launch, ...rest] = terminalLaunches(
      "win32",
      { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      CWD,
      'GING: "repo"'
    );
    expect(rest).toEqual([]);
    expect(launch).toEqual({
      command: "C:\\Windows\\system32\\cmd.exe",
      // `start` reads its first quoted argument as the title; a quote inside
      // it would end the title early, so none is kept.
      args: ["/d", "/c", "start", '"GING: repo"', "cmd.exe"],
      options: {
        cwd: CWD,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true
      }
    });
  });

  it("finds cmd under the system root when ComSpec is not set", () => {
    const [launch] = terminalLaunches("win32", { SystemRoot: "D:\\Win" }, CWD, "GING: repo");
    expect(launch.command).toBe("D:\\Win\\System32\\cmd.exe");
  });

  it("opens Terminal on the folder on macOS", () => {
    expect(terminalLaunches("darwin", {}, "/work/repo", "GING: repo")).toEqual([
      {
        command: "open",
        args: ["-a", "Terminal", "/work/repo"],
        options: { cwd: "/work/repo", detached: true, stdio: "ignore" }
      }
    ]);
  });

  it("tries Debian's choice, then the desktop's own, then xterm on Linux", () => {
    const programs = (env: NodeJS.ProcessEnv) =>
      terminalLaunches("linux", env, "/work/repo", "GING: repo").map((l) => l.command);

    expect(programs({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
      "xterm"
    ]);
    expect(programs({ XDG_CURRENT_DESKTOP: "KDE" })).toEqual([
      "x-terminal-emulator",
      "konsole",
      "xterm"
    ]);
    expect(programs({ DESKTOP_SESSION: "xfce" })).toEqual([
      "x-terminal-emulator",
      "xfce4-terminal",
      "xterm"
    ]);
    expect(programs({})).toEqual(["x-terminal-emulator", "xterm"]);
    for (const launch of terminalLaunches("linux", {}, "/work/repo", "t")) {
      expect(launch.options).toEqual({ cwd: "/work/repo", detached: true, stdio: "ignore" });
    }
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

  it("does not try the next program for a failure that is not a missing one", async () => {
    const fake = fakeSpawn({ a: "EACCES" });

    await expect(launchTerminal(fake.spawn, launches("a", "b"))).rejects.toThrow("spawn a EACCES");
    expect(fake.spawned).toEqual(["a"]);
  });
});
