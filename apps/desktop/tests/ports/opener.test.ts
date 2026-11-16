import path from "node:path";

import { describe, expect, it } from "vitest";

import type { L10nArg } from "@ging/core/host/ports";
import { createDesktopOpener, type OsShell, opensAsProgram } from "@ging/desktop/ports/opener";

// The desktop Opener (#391), over a fake of what the system opens things
// with: nothing here starts a program, a browser or a terminal.

const NOT_YET = "desktop.notSupportedYet";

function setUp({
  platform = "linux" as NodeJS.Platform,
  openPath = async (_file: string) => "",
  openTerminal = async (_cwd: string, _title: string) => {}
} = {}) {
  const calls: unknown[][] = [];
  const logged: string[] = [];
  const os: OsShell = {
    openPath: (file) => {
      calls.push(["openPath", file]);
      return openPath(file);
    },
    showItemInFolder: (file) => calls.push(["showItemInFolder", file]),
    openExternal: async (url) => {
      calls.push(["openExternal", url]);
    },
    openTerminal: (cwd, title) => {
      calls.push(["openTerminal", cwd, title]);
      return openTerminal(cwd, title);
    }
  };
  const opener = createDesktopOpener({
    os,
    prompts: {
      showInformation: async (message: string) => {
        calls.push(["showInformation", message]);
        return undefined;
      },
      showError: async (message) => {
        calls.push(["showError", message]);
        return undefined;
      }
    },
    l10n: { t: (key: string, ...args: L10nArg[]) => [key, ...args].join(" ") },
    logger: {
      log: (line) => logged.push(line),
      logError: (line) => logged.push(`ERROR: ${line}`)
    },
    platform,
    env: {}
  });
  return { opener, calls, logged };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the desktop Opener", () => {
  it("opens a working-tree file with the system's program for it", async () => {
    const { opener, calls, logged } = setUp();

    await opener.openFile("/work/repo/src/a.txt");

    expect(calls).toEqual([["openPath", path.normalize("/work/repo/src/a.txt")]]);
    expect(logged).toEqual([]);
  });

  it("rejects, saying why in the log, when the system could not open the file", async () => {
    const { opener, logged } = setUp({ openPath: async () => "Failed to open path" });

    await expect(opener.openFile("/work/repo/a.txt")).rejects.toThrow("Failed to open path");
    expect(logged).toEqual([expect.stringMatching(/^ERROR: opener: could not open .*a\.txt/)]);
  });

  it("shows a file the system would run in its folder instead of opening it", async () => {
    const { opener, calls } = setUp({ platform: "win32" });

    await opener.openFile("C:/work/repo/setup.bat");

    expect(calls).toEqual([["showItemInFolder", path.normalize("C:/work/repo/setup.bat")]]);
  });

  it("opens web addresses in the browser, and nothing else", async () => {
    const { opener, calls, logged } = setUp();

    opener.openExternalUrl("https://example.com/issues/1");
    opener.openExternalUrl("file:///etc/passwd");
    opener.openExternalUrl("ms-settings:privacy");

    expect(calls).toEqual([["openExternal", "https://example.com/issues/1"]]);
    expect(logged).toEqual([
      "opener: not opening file:///etc/passwd: not a web address",
      "opener: not opening ms-settings:privacy: not a web address"
    ]);
  });

  it("starts the system's terminal in the folder, titled as asked", async () => {
    const { opener, calls } = setUp();

    opener.openTerminal("/work/repo", "GING: repo");
    await settled();

    expect(calls).toEqual([["openTerminal", path.normalize("/work/repo"), "GING: repo"]]);
  });

  it("says so in an error when no terminal could be started", async () => {
    const { opener, calls, logged } = setUp({
      openTerminal: async () => {
        throw new Error("spawn xterm ENOENT");
      }
    });

    opener.openTerminal("/work/repo", "GING: repo");
    await settled();

    expect(calls.at(-1)).toEqual([
      "showError",
      "desktop.cannotOpenTerminal Error: spawn xterm ENOENT"
    ]);
    expect(logged).toEqual([expect.stringContaining("ERROR: opener: could not open a terminal")]);
  });

  // The stubs: each says the desktop app cannot do it yet, and answers as
  // done, so the graph adds no "Unable to open" box of its own.
  describe("what the desktop app cannot show yet", () => {
    const side = { repo: "/work/repo", filePath: "a.txt", commit: "abc" };

    it.each([
      ["openFileAtRevision", (o: ReturnType<typeof setUp>["opener"]) => o.openFileAtRevision(side)],
      [
        "diffWithWorking",
        (o: ReturnType<typeof setUp>["opener"]) => o.diffWithWorking(side, "/work/repo/a.txt", "t")
      ]
    ])("%s resolves after the notice", async (_name, open) => {
      const { opener, calls, logged } = setUp();

      await expect(open(opener)).resolves.toBeUndefined();

      expect(calls).toEqual([["showInformation", NOT_YET]]);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
    });

    it("openCommitDiff resolves to true after the notice", async () => {
      const { opener, calls } = setUp();

      await expect(
        opener.openCommitDiff({
          repo: "/work/repo",
          commitHash: "abc",
          oldFilePath: "a.txt",
          newFilePath: "a.txt",
          type: "M"
        })
      ).resolves.toBe(true);
      expect(calls).toEqual([["showInformation", NOT_YET]]);
    });

    it("openMergeEditor gives the notice", () => {
      const { opener, calls, logged } = setUp();

      opener.openMergeEditor("/work/repo", "a.txt");

      expect(calls).toEqual([["showInformation", NOT_YET]]);
      expect(logged).toEqual(["desktop: merging a.txt (#410) is not supported yet"]);
    });
  });
});

describe("opensAsProgram", () => {
  it("knows Windows' runnable extensions, PATHEXT's included", () => {
    const env = { PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PY" };
    for (const file of ["a.exe", "b.CMD", "c.js", "d.py", "e.lnk", "f.hta", "g.msi"]) {
      expect(opensAsProgram(file, "win32", env), file).toBe(true);
    }
    for (const file of ["a.txt", "b.ts", "README", "c.png", "d.json"]) {
      expect(opensAsProgram(file, "win32", env), file).toBe(false);
    }
  });

  it("falls back to Windows' own PATHEXT when the variable is not set", () => {
    expect(opensAsProgram("a.vbs", "win32", {})).toBe(true);
    expect(opensAsProgram("a.ts", "win32", {})).toBe(false);
  });

  it("knows what macOS and Linux run when opened", () => {
    expect(opensAsProgram("Run.command", "darwin", {})).toBe(true);
    expect(opensAsProgram("App.app", "darwin", {})).toBe(true);
    expect(opensAsProgram("a.desktop", "linux", {})).toBe(true);
    expect(opensAsProgram("tool.AppImage", "linux", {})).toBe(true);
    expect(opensAsProgram("a.md", "darwin", {})).toBe(false);
    expect(opensAsProgram("a.c", "linux", {})).toBe(false);
  });
});
